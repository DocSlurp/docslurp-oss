#!/usr/bin/env python3
"""Deterministic procedural capture variants for V3 native pages.

A scene plate (desk surface, paper under directional light falloff, an optional
cast shadow and an optional occluding object) is generated procedurally from a
seed - no photographs and no AI image generation. The annotated page is then
projected into the plate's calibrated print quad by the unchanged
``capture.compose`` (exact homography, occlusion visibility per region), and
optional deterministic degradations come from ``quality_capture.derive``.

Variants are capture-robustness evidence only. They never count as new layouts
and always inherit their parent page's source cluster and split.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

try:
    from . import capture, quality_capture
except ImportError:
    import capture
    import quality_capture

RECIPE_VERSION = 'procedural-desk-plate-v1'


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def plate(page_size, recipe, seed):
    """Return (plate image, print quad, occlusion polygons, recipe record)."""
    rng = np.random.default_rng(seed)
    pw, ph = page_size
    scale = recipe.get('page_scale', 0.78)
    W = round(pw * scale / 0.74)
    H = round(ph * scale / 0.80)
    # desk: two-tone gradient with low-frequency mottling and fine grain
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    desk = np.array(recipe.get('desk', (92, 74, 58)), dtype=np.float32)
    mottling = Image.fromarray((rng.random((H // 40 + 2, W // 40 + 2)) * 255).astype(np.uint8)).resize((W, H), Image.Resampling.BICUBIC)
    mottle = np.asarray(mottling, dtype=np.float32) / 255 - .5
    grain = rng.normal(0, 3.0, (H, W)).astype(np.float32)
    base = desk[None, None, :] * (0.9 + 0.12 * (xx / W))[:, :, None] + (mottle * 18 + grain)[:, :, None]
    # print quad: centred page with perspective corner offsets
    cw, ch = pw * scale, ph * scale
    cx, cy = W / 2 + recipe.get('shift', (0, 0))[0], H / 2 + recipe.get('shift', (0, 0))[1]
    tilt = recipe.get('perspective', 0.0)
    rot = math.radians(recipe.get('rotation_deg', 0.0))
    corners = np.array([[-cw / 2, -ch / 2], [cw / 2, -ch / 2], [cw / 2, ch / 2], [-cw / 2, ch / 2]])
    corners[0, 0] += tilt * cw
    corners[1, 0] -= tilt * cw
    corners[0, 1] += tilt * ch * .15
    corners[1, 1] += tilt * ch * .15
    rotated = corners @ np.array([[math.cos(rot), math.sin(rot)], [-math.sin(rot), math.cos(rot)]])
    quad = (rotated + [cx, cy]).round(2).tolist()
    # paper: white sheet under light falloff, optional cast shadow band
    paper_mask = Image.new('L', (W, H))
    ImageDraw.Draw(paper_mask).polygon([tuple(p) for p in quad], fill=255)
    paper_mask = np.asarray(paper_mask.filter(ImageFilter.GaussianBlur(0.8)), dtype=np.float32) / 255
    lx, ly = recipe.get('light_center', (0.3, 0.2))
    falloff = recipe.get('falloff', 0.25)
    distance = np.sqrt(((xx / W) - lx) ** 2 + ((yy / H) - ly) ** 2)
    light = 1.0 - falloff * np.clip(distance / 1.1, 0, 1)
    paper_tone = np.array(recipe.get('paper', (246, 243, 236)), dtype=np.float32)
    paper = paper_tone[None, None, :] * light[:, :, None] + rng.normal(0, 1.6, (H, W, 1)).astype(np.float32)
    shadow_record = None
    if recipe.get('shadow'):
        s = recipe['shadow']
        shadow = Image.new('L', (W, H))
        poly = [(x * W, y * H) for x, y in s['polygon']]
        ImageDraw.Draw(shadow).polygon(poly, fill=255)
        shadow = np.asarray(shadow.filter(ImageFilter.GaussianBlur(s.get('softness', 40))), dtype=np.float32) / 255
        paper *= (1 - s.get('strength', .35) * shadow)[:, :, None]
        base *= (1 - s.get('strength', .35) * shadow)[:, :, None]
        shadow_record = {'polygon_px': [list(p) for p in poly], 'strength': s.get('strength', .35), 'softness_px': s.get('softness', 40)}
    image = base * (1 - paper_mask[:, :, None]) + paper * paper_mask[:, :, None]
    occlusions = []
    out = Image.fromarray(np.clip(image, 0, 255).astype(np.uint8))
    if recipe.get('occluder'):
        o = recipe['occluder']
        d = ImageDraw.Draw(out)
        poly = [(x * W, y * H) for x, y in o['polygon']]
        d.polygon(poly, fill=tuple(o.get('color', (40, 44, 52))))
        if o.get('highlight'):
            hl = [(x * W, y * H) for x, y in o['highlight']]
            d.polygon(hl, fill=tuple(o.get('highlight_color', (120, 126, 138))))
        occlusions.append([[round(x, 2), round(y, 2)] for x, y in poly])
    record = {'recipe_version': RECIPE_VERSION, 'seed': seed, 'recipe': recipe, 'scene_size': [W, H], 'print_quad': quad,
              'shadow': shadow_record, 'occluder_polygons_px': occlusions,
              'kind': 'procedural-synthetic-scene-plate', 'not_a_photograph': True, 'ai_generated': False}
    return out, quad, occlusions, record


def lighting_description(recipe):
    """Recipe facts only (no measured photometry): falloff strength and any cast shadow."""
    parts = [f"procedural radial light falloff {recipe.get('falloff', 0.25):.2f} from {tuple(recipe.get('light_center', (0.3, 0.2)))}"]
    if recipe.get('shadow'):
        parts.append(f"cast shadow band strength {recipe['shadow'].get('strength', .35):.2f}")
    return '; '.join(parts)


def make_variant(root, parent_id, variant_id, recipe, seed, degradations=()):
    """Create one capture variant (plus optional chained quality derivatives) under root/captures."""
    root = Path(root)
    out = root / 'captures'
    plates = out / 'plates'
    plates.mkdir(parents=True, exist_ok=True)
    reference = root / 'references' / f'{parent_id}.json'
    image = root / 'images' / f'{parent_id}.png'
    with Image.open(image) as im:
        size = im.size
    scene, quad, occlusions, record = plate(size, recipe, seed)
    scene_path = plates / f'{variant_id}.plate.png'
    scene.save(scene_path)
    calibration = {'scene_size': list(scene.size), 'scene_sha256': sha(scene_path), 'print_quad': quad,
                   'occlusion_polygons': occlusions, 'occlusion_feather_px': 0.8,
                   'lighting': lighting_description(recipe),
                   'occluder_kind': recipe.get('occluder', {}).get('kind', 'object') if occlusions else None,
                   'calibration_method': 'exact: quad and occluder polygons are the generator inputs, not manual tracing',
                   'plate_generation': record}
    calibration_path = plates / f'{variant_id}.calibration.json'
    calibration_path.write_text(json.dumps(calibration, indent=2) + '\n')
    row = capture.compose(image, reference, scene_path, calibration_path, out, variant_id)
    row['metadata']['kind'] = 'procedural-synthetic-capture-composite'
    row['metadata']['scene_generation'] = {'recipe_version': RECIPE_VERSION, 'calibration_sha256': sha(calibration_path), 'ai_generated': False}
    rows = [row]
    current_image, current_ref, current_id = Path(row['image_path']), Path(row['reference_path']), variant_id
    for kind, parameter in degradations:
        derived_id = f'{current_id}-{"blur" if kind == "gaussian-blur" else "dim" if kind == "digital-underexposure" else "lowres"}'
        derived = quality_capture.derive(current_image, current_ref, out, derived_id, kind, parameter)
        rows.append(derived)
        current_image, current_ref, current_id = Path(derived['image_path']), Path(derived['reference_path']), derived_id
    for r in rows:
        (out / f'{r["id"]}.row.json').write_text(json.dumps(r, indent=2) + '\n')
    return rows


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--root', type=Path, required=True)
    p.add_argument('--plan', type=Path, required=True, help='JSON list of {parent, id, seed, recipe, degradations}')
    a = p.parse_args()
    plan = json.loads(a.plan.read_text())
    produced = []
    for item in plan:
        rows = make_variant(a.root, item['parent'], item['id'], item['recipe'], item['seed'], [tuple(d) for d in item.get('degradations', [])])
        produced.extend(r['id'] for r in rows)
    print(json.dumps({'variants': len(produced), 'ids': produced}, indent=1))


if __name__ == '__main__':
    main()
