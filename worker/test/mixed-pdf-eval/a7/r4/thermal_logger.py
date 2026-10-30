"""Standalone, text-free logger/probe primitives for the existing native producers.

No imports of candidate authoring code, assets, fonts, or document content.
Coordinates are fixed page points, top-left origin. This is a generic illustration,
not a product drawing or measurement. The return value is fresh on every call.
"""
import hashlib
import json

ENVELOPE_PT = (410, 516.25, 580, 643.75)


def thermal_logger(id_prefix='side.image', container_pt=ENVELOPE_PT):
    """Return objects, a schema-compatible frame leaf, and primitive support data.

    Objects use precisely the R2 rect/path interface (a path is a polyline).
    Keep the parent ID stable, but give every painted object a distinct child ID.
    The fixed placement is deliberately not scalable or candidate-fitted.
    """
    if list(container_pt) != list(ENVELOPE_PT):
        raise ValueError('This illustration requires its fixed 170 x 127.5 pt envelope')
    if not isinstance(id_prefix, str) or not id_prefix:
        raise ValueError('A nonempty parent ID is required')
    ink = [.24, .32, .37]
    secondary = [.43, .51, .55]
    shell = [.94, .96, .965]
    recess = [.84, .89, .90]
    objects = []

    def rect(name, box, fill, z):
        objects.append(dict(id=id_prefix+'.'+name, kind='rect', rectPt=list(box),
                            fill=list(fill), z=z))

    def line(name, pts, width=.7, color=None, z=19):
        objects.append(dict(id=id_prefix+'.'+name, kind='path',
                            pointsPt=[list(p) for p in pts],
                            color=list(color or ink), widthPt=width, z=z))

    def border(name, box, width=.7, color=None, z=19):
        x,y,r,b=box
        line(name, [(x,y),(r,y),(r,b),(x,b),(x,y)], width, color, z)

    # Cubic construction is flattened into ordinary, deterministic polylines;
    # neither producer needs a new curve interface.
    cable=[(508,591)]
    for a,b,c,d in [((508,591),(521,591),(528,598),(529,611)),
                    ((529,611),(530,637),(560,638),(560,612)),
                    ((560,612),(560,602),(559,597),(557,591))]:
        for i in range(1,17):
            t=i/16; u=1-t
            cable.append(tuple(round(u*u*u*a[j]+3*u*u*t*b[j]+3*u*t*t*c[j]+t*t*t*d[j],4) for j in (0,1)))
    # Cable is behind the instrument and probe. Its gentle loop is a lead, not data.
    line('cable', cable, 1.7, ink, 15)
    # Extruded right wall and lower shell lip establish enclosure depth.
    rect('wall.fill', [499,539,507,615], [.83,.87,.89], 16)
    rect('lip.fill', [433,613,501,619], [.88,.91,.92], 16)
    line('wall.outline', [(499,533),(507,539),(507,615),(501,619),
                          (433,619),(427,613)], .95, ink, 17)
    line('wall.seam', [(499,613),(507,615)], .6, secondary, 18)
    rect('face.fill', [427,533,499,613], shell, 17)
    border('face.outline', [427,533,499,613], 1.1)
    # Blank inset LCD with a dark bezel and a restrained lower reveal.
    rect('lcd.bezel', [436,545,490,574], ink, 18)
    rect('lcd.blank', [439,548,487,570], recess, 19)
    rect('lcd.reveal', [439,570,487,571], [.65,.73,.76], 20)
    # Small square status lens and two unlabeled physical buttons.
    rect('indicator.socket', [479,537,490,541], secondary, 18)
    rect('indicator.lens', [481,538,488,540], [.63,.76,.73], 19)
    for name,x in [('left',438),('right',458)]:
        rect('button.'+name+'.fill', [x,583,x+13,592], [.85,.89,.91], 18)
        border('button.'+name+'.edge', [x,583,x+13,592], .7)
        line('button.'+name+'.reveal', [(x+2,590),(x+11,590)], .45, secondary)
    # Captive corner fasteners: small squares and slots, with no lettering.
    for name,x,y in [('tl',431,537),('tr',493,537),('bl',431,605),('br',493,605)]:
        border('fastener.'+name, [x,y,x+2.5,y+2.5], .45, secondary)
        line('fastener.'+name+'.slot', [(x+.6,y+1.25),(x+1.9,y+1.25)], .4, secondary)
    # Two physically different right-wall connector ports; lower one carries lead.
    rect('port.upper.recess', [500,557,506,568], ink, 18)
    rect('port.upper.opening', [501.5,559,504.5,566], [.67,.74,.77], 19)
    for i,y in enumerate([560.5,563,565.5]):
        line('port.upper.contact'+str(i), [(502,y),(504,y)], .45, shell, 20)
    rect('port.lower.socket', [500,585,508,596], ink, 18)
    rect('plug.fill', [505,587,513,594], [.77,.83,.85], 19)
    border('plug.outline', [505,587,513,594], .7, z=20)
    for i,x in enumerate([514,516,518]):
        line('plug.relief'+str(i), [(x,590),(x,593)], .75, ink, 20)
    # Slim stainless-style immersion shaft, shoulder, grip and strain relief.
    # Its blank shaft is not a thermometer scale and contains no reading.
    rect('probe.shaft.fill', [555,529,559,572], [.91,.94,.95], 17)
    border('probe.shaft.edge', [555,529,559,572], .8, z=18)
    line('probe.shaft.highlight', [(557.8,533),(557.8,569)], .4, secondary, 19)
    rect('probe.shoulder.fill', [553,571,561,575], [.76,.83,.86], 18)
    border('probe.shoulder.edge', [553,571,561,575], .7)
    rect('probe.grip.fill', [551.5,575,562.5,588], [.86,.90,.92], 18)
    border('probe.grip.edge', [551.5,575,562.5,588], .9)
    for i,y in enumerate([578,581,584]):
        line('probe.grip.rib'+str(i), [(553,y),(561,y)], .6, secondary, 20)
    rect('probe.relief.fill', [554,588,560,593], secondary, 18)
    for i,y in enumerate([589,591]):
        line('probe.relief.rib'+str(i), [(553.5,y),(560.5,y)], .6, ink, 20)

    def bbox(obj):
        if obj['kind']=='rect':
            return list(obj['rectPt'])
        pts=obj['pointsPt']; h=obj['widthPt']/2
        return [min(p[0] for p in pts)-h, min(p[1] for p in pts)-h,
                max(p[0] for p in pts)+h, max(p[1] for p in pts)+h]

    def union(boxes):
        return [min(b[0] for b in boxes),min(b[1] for b in boxes),
                max(b[2] for b in boxes),max(b[3] for b in boxes)]

    child_support=[dict(id=o['id'], kind=o['kind'], occupiedBBoxPt=bbox(o)) for o in objects]
    occupied=union([s['occupiedBBoxPt'] for s in child_support])
    # All filled rectangles are bounded by genuine strokes elsewhere in this
    # illustration; therefore these real stroked paths also give the same union.
    paths=[o for o in objects if o['kind']=='path']
    assert union([bbox(o) for o in paths]) == occupied
    assert ENVELOPE_PT[0] < occupied[0] < occupied[2] < ENVELOPE_PT[2]
    assert ENVELOPE_PT[1] < occupied[1] < occupied[3] < ENVELOPE_PT[3]
    leaf=dict(id=id_prefix,kind='frame',containerPt=list(ENVELOPE_PT),
              expectedSupportPt=occupied,glyphs=[],
              primitivePaths=[json.dumps(o,sort_keys=True) for o in paths],
              semanticSerialization='',visibleGlyphSequence='',lineBreakOffsets=[],
              readingRank=None,zOrder=15,visible=True)
    geometry=dict(schema='text-free-native-illustration@1',parentId=id_prefix,
                  placementEnvelopePt=list(ENVELOPE_PT),occupiedBBoxPt=occupied,
                  supportConvention='rect fill bounds; polyline vertex bounds expanded by half stroke width (R2 convention)',
                  children=child_support,
                  childIds=[o['id'] for o in objects],
                  roles={'enclosure':'face', 'display':'lcd.blank', 'controls':'button',
                         'connectors':'port', 'temperatureProbe':'probe', 'lead':'cable'})
    canonical=json.dumps(objects,sort_keys=True,separators=(',',':'),allow_nan=False).encode()
    geometry['objectsSha256']=hashlib.sha256(canonical).hexdigest()
    return dict(objects=objects,leaf=leaf,geometry=geometry)
