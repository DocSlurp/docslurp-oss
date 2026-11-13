#!/usr/bin/env python3
"""Generate the free-rung chart-export benchmark corpus (office-chart-xml, embedded-spec, svg-geometry).

Everything is synthetic and seeded, so the corpus is reproducible and carries no third-party content. Fixtures are
written OUTSIDE the repository (the output directory argument); only this generator is committed.

    uv venv venv && VIRTUAL_ENV=venv uv pip install matplotlib openpyxl python-pptx vl-convert-python
    venv/bin/python -I gen_fixtures.py OUT_DIR

Output layout:
  svg/        matplotlib-native SVG charts (the upload / extracted-media path)
  pdf/        the same kinds of charts as vector PDFs (run Doppler `pdftomarkdown --images-dir` on them for figures)
  vega/       Vega-Lite charts rendered to SVG by vl-convert (vega generator markup)
  html/       HTML pages with embedded Vega-Lite and Plotly specs (embedded-spec rung)
  json/       standalone Vega-Lite JSON specs
  office/     XLSX / PPTX / DOCX with native DrawingML charts
  adversarial/ oversized and pathological inputs (must refuse or stay bounded, never crash)
"""
import io
import json
import math
import os
import random
import sys
import zipfile

import matplotlib

matplotlib.use("svg")
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib.backends.backend_pdf import PdfPages  # noqa: E402

OUT = sys.argv[1]
SEED = 20261112
rng = random.Random(SEED)
plt.rcParams["svg.hashsalt"] = "docslurp-bench"
plt.rcParams["svg.fonttype"] = "path"  # matplotlib default: glyph paths plus a comment holding the text

CATS = ["North", "South", "East", "West", "Central", "Coastal", "Highland", "Valley"]
YEARS = [str(y) for y in range(2015, 2027)]


def series(n, lo=10, hi=100):
    return [round(rng.uniform(lo, hi), 1) for _ in range(n)]


def mkdir(*parts):
    p = os.path.join(OUT, *parts)
    os.makedirs(p, exist_ok=True)
    return p


def chart_bar(ax):
    ax.bar(CATS[:6], series(6))
    ax.set_title("Revenue by region")
    ax.set_ylabel("USD m")


def chart_grouped(ax):
    w = 0.25
    xs = list(range(5))
    for k, name in enumerate(["2024", "2025", "2026"]):
        ax.bar([x + k * w for x in xs], series(5), width=w, label=name)
    ax.set_xticks([x + w for x in xs], CATS[:5])
    ax.legend()
    ax.set_title("Bookings by region and year")


def chart_line(ax):
    for name in ["Seats", "Upgrades", "Renewals"]:
        ax.plot(YEARS, series(len(YEARS)), label=name)
    ax.legend()
    ax.set_title("Growth by product line")


def chart_scatter(ax):
    xs = [rng.uniform(0, 100) for _ in range(200)]
    ax.scatter(xs, [x * 0.8 + rng.uniform(-10, 10) for x in xs], s=8)
    ax.set_title("Latency vs pages")


def chart_log(ax):
    ax.semilogy(YEARS, [10 ** (1 + k * 0.3) for k in range(len(YEARS))], marker="o")
    ax.set_title("Pages indexed (log)")


def chart_hbar(ax):
    ax.barh(CATS, series(len(CATS)))
    ax.set_title("Throughput by site")


def chart_dense_line(ax):
    xs = list(range(2000))
    for k in range(4):
        ax.plot(xs, [math.sin(x / (50 + 20 * k)) * 40 + 50 + rng.uniform(-2, 2) for x in xs], label=f"s{k}")
    ax.legend()
    ax.set_title("Sensor trace")


CHARTS = [chart_bar, chart_grouped, chart_line, chart_scatter, chart_log, chart_hbar, chart_dense_line]


def matplotlib_svgs():
    d = mkdir("svg")
    for fn in CHARTS:
        fig, ax = plt.subplots(figsize=(6.4, 4.0))
        fn(ax)
        fig.savefig(os.path.join(d, f"mpl-{fn.__name__[6:]}.svg"), metadata={"Date": None})
        plt.close(fig)


def matplotlib_pdfs():
    d = mkdir("pdf")
    # A report-style PDF: two charts per page plus a text paragraph, 6 pages.
    with PdfPages(os.path.join(d, "vector-charts-report.pdf"), metadata={"CreationDate": None}) as pdf:
        for page in range(6):
            fig, axes = plt.subplots(2, 1, figsize=(8.5, 11))
            for k, ax in enumerate(axes):
                CHARTS[(page * 2 + k) % len(CHARTS)](ax)
            fig.text(0.1, 0.02, f"Page {page + 1}: quarterly operating review, figures generated for benchmarking.")
            pdf.savefig(fig)
            plt.close(fig)
    # One chart per page, every kind.
    with PdfPages(os.path.join(d, "vector-charts-single.pdf"), metadata={"CreationDate": None}) as pdf:
        for fn in CHARTS:
            fig, ax = plt.subplots(figsize=(8.5, 5.5))
            fn(ax)
            pdf.savefig(fig)
            plt.close(fig)


def vega_specs():
    vals = [{"region": c, "value": v} for c, v in zip(CATS, series(len(CATS)))]
    line = [{"year": y, "series": s, "value": v} for s in ["A", "B", "C"] for y, v in zip(YEARS, series(len(YEARS)))]
    pts = [{"x": round(rng.uniform(0, 100), 2), "y": round(rng.uniform(0, 100), 2)} for _ in range(150)]
    base = "https://vega.github.io/schema/vega-lite/v5.json"
    return {
        "bar": {"$schema": base, "data": {"values": vals}, "mark": "bar", "encoding": {"x": {"field": "region", "type": "nominal"}, "y": {"field": "value", "type": "quantitative"}}},
        "line": {"$schema": base, "data": {"values": line}, "mark": "line", "encoding": {"x": {"field": "year", "type": "ordinal"}, "y": {"field": "value", "type": "quantitative"}, "color": {"field": "series", "type": "nominal"}}},
        "scatter": {"$schema": base, "data": {"values": pts}, "mark": "point", "encoding": {"x": {"field": "x", "type": "quantitative"}, "y": {"field": "y", "type": "quantitative"}}},
    }


def vega_outputs():
    specs = vega_specs()
    dj = mkdir("json")
    dh = mkdir("html")
    for name, spec in specs.items():
        with open(os.path.join(dj, f"vl-{name}.json"), "w") as f:
            json.dump(spec, f)
    try:
        import vl_convert as vlc

        dv = mkdir("vega")
        for name, spec in specs.items():
            with open(os.path.join(dv, f"vl-{name}.svg"), "w") as f:
                f.write(vlc.vegalite_to_svg(spec))
    except ImportError:
        print("vl-convert not installed: skipping vega SVGs", file=sys.stderr)
    # HTML: a report page with three vega-embed specs and a Plotly.newPlot call.
    plotly = [{"type": "bar", "x": CATS[:5], "y": series(5), "name": "Pipeline"}, {"type": "bar", "x": CATS[:5], "y": series(5), "name": "Closed"}]
    body = ["<!doctype html><html><head><title>Ops report</title></head><body>", "<p>" + "Quarterly summary. " * 200 + "</p>"]
    for k, (name, spec) in enumerate(specs.items()):
        body.append(f'<div id="v{k}"></div><script>vegaEmbed("#v{k}", {json.dumps(spec)});</script>')
    body.append(f'<div id="p"></div><script>Plotly.newPlot("p", {json.dumps(plotly)}, {{"title": "Pipeline"}});</script>')
    body.append('<script type="application/json">' + json.dumps(specs["bar"]) + "</script>")
    body.append("</body></html>")
    with open(os.path.join(dh, "report-embedded.html"), "w") as f:
        f.write("\n".join(body))


def office_files():
    from openpyxl import Workbook
    from openpyxl.chart import BarChart, LineChart, PieChart, Reference, ScatterChart, Series

    d = mkdir("office")
    wb = Workbook()
    ws = wb.active
    ws.title = "Data"
    ws.append(["Year", "Seats", "Upgrades", "Renewals"])
    for y in YEARS:
        ws.append([int(y)] + series(3))
    n = len(YEARS) + 1
    for k, Kind in enumerate([BarChart, LineChart, PieChart]):
        ch = Kind()
        ch.title = f"Chart {k + 1}"
        ch.add_data(Reference(ws, min_col=2, min_row=1, max_col=2 if Kind is PieChart else 4, max_row=n), titles_from_data=True)
        ch.set_categories(Reference(ws, min_col=1, min_row=2, max_row=n))
        ws.add_chart(ch, f"F{1 + k * 16}")
    sc = ScatterChart()
    sc.title = "Scatter"
    sc.series.append(Series(Reference(ws, min_col=3, min_row=1, max_row=n), Reference(ws, min_col=2, min_row=2, max_row=n), title_from_data=True))
    ws.add_chart(sc, "F50")
    wb.save(os.path.join(d, "workbook-4-charts.xlsx"))

    # A big workbook: 40 charts over 1,000-row series (adversarial-size but legitimate).
    wb = Workbook()
    ws = wb.active
    ws.append(["i"] + [f"s{k}" for k in range(8)])
    for i in range(1000):
        ws.append([i] + [round(rng.uniform(0, 100), 2) for _ in range(8)])
    for k in range(40):
        ch = LineChart()
        ch.title = f"Trace {k}"
        ch.add_data(Reference(ws, min_col=2 + k % 8, min_row=1, max_row=1001), titles_from_data=True)
        ch.set_categories(Reference(ws, min_col=1, min_row=2, max_row=1001))
        ws.add_chart(ch, f"K{1 + k * 16}")
    wb.save(os.path.join(d, "workbook-40-charts-1k-rows.xlsx"))

    from pptx import Presentation
    from pptx.chart.data import CategoryChartData, XyChartData
    from pptx.enum.chart import XL_CHART_TYPE
    from pptx.util import Inches

    prs = Presentation()
    kinds = [XL_CHART_TYPE.COLUMN_CLUSTERED, XL_CHART_TYPE.LINE_MARKERS, XL_CHART_TYPE.PIE, XL_CHART_TYPE.BAR_STACKED, XL_CHART_TYPE.AREA, XL_CHART_TYPE.DOUGHNUT]
    for s in range(12):
        slide = prs.slides.add_slide(prs.slide_layouts[5])
        slide.shapes.title.text = f"Slide {s + 1}"
        cd = CategoryChartData()
        cd.categories = CATS[:6]
        for name in (["Plan"] if kinds[s % len(kinds)] in (XL_CHART_TYPE.PIE, XL_CHART_TYPE.DOUGHNUT) else ["Plan", "Actual"]):
            cd.add_series(name, series(6))
        slide.shapes.add_chart(kinds[s % len(kinds)], Inches(1), Inches(1.5), Inches(8), Inches(5), cd)
    slide = prs.slides.add_slide(prs.slide_layouts[5])
    xy = XyChartData()
    sr = xy.add_series("Points")
    for _ in range(100):
        sr.add_data_point(rng.uniform(0, 10), rng.uniform(0, 10))
    slide.shapes.add_chart(XL_CHART_TYPE.XY_SCATTER, Inches(1), Inches(1.5), Inches(8), Inches(5), xy)
    pptx_path = os.path.join(d, "deck-13-charts.pptx")
    prs.save(pptx_path)

    # DOCX: python-docx has no chart API, so build a minimal package around a chart part taken from the deck.
    with zipfile.ZipFile(pptx_path) as z:
        chart_xml = z.read("ppt/charts/chart1.xml")
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/charts/chart1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/></Types>')
        z.writestr("_rels/.rels", '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
        z.writestr("word/document.xml", '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Quarterly review</w:t></w:r></w:p></w:body></w:document>')
        z.writestr("word/_rels/document.xml.rels", '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="charts/chart1.xml"/></Relationships>')
        z.writestr("word/charts/chart1.xml", chart_xml)
    with open(os.path.join(d, "report-1-chart.docx"), "wb") as f:
        f.write(buf.getvalue())


def adversarial():
    d = mkdir("adversarial")
    # Just under the 5 MiB text limit: one path with ~200k segments (path-command budget).
    segs = " ".join(f"L{i % 500} {(i * 7) % 300}" for i in range(190_000))
    with open(os.path.join(d, "huge-path.svg"), "w") as f:
        f.write(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 500 300"><path d="M0 0 {segs}"/></svg>')
    # Many small elements near the element cap.
    with open(os.path.join(d, "many-rects.svg"), "w") as f:
        f.write('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000">')
        for i in range(60_000):
            f.write(f'<rect x="{i % 1000}" y="{(i // 1000) * 10}" width="1" height="{1 + i % 9}" fill="#3366cc"/>')
        f.write("</svg>")
    # Deep nesting near the depth cap.
    with open(os.path.join(d, "deep-groups.svg"), "w") as f:
        f.write('<svg xmlns="http://www.w3.org/2000/svg">' + '<g transform="translate(1,1)">' * 250 + '<rect width="5" height="5" fill="red"/>' + "</g>" * 250 + "</svg>")
    # <use> fan-out (billion-laughs style references; capped by maxUseExpansions / maxUseDepth).
    with open(os.path.join(d, "use-fanout.svg"), "w") as f:
        f.write('<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><defs><rect id="l0" width="1" height="1" fill="#000"/>')
        for k in range(1, 9):
            f.write(f'<g id="l{k}">' + "".join(f'<use xlink:href="#l{k - 1}" x="{j}"/>' for j in range(10)) + "</g>")
        f.write('</defs><use xlink:href="#l8"/></svg>')
    # Many text labels (tick-heavy, quadratic-risk paths in clustering / legend matching).
    with open(os.path.join(d, "many-texts.svg"), "w") as f:
        f.write('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2000 2000">')
        for i in range(20_000):
            f.write(f'<text x="{(i % 100) * 20}" y="{(i // 100) * 10}" font-size="8">{i}</text>')
        f.write("</svg>")
    # Point markers vs long polylines (marker de-duplication cost grows with points x vertices if done pairwise).
    with open(os.path.join(d, "markers-vs-lines.svg"), "w") as f:
        f.write('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4000 1000">')
        for t in range(6):
            f.write(f'<text x="20" y="{900 - t * 150}" text-anchor="end">{t * 20}</text><text x="{100 + t * 700}" y="980">{t}</text>')
        for k in range(12):
            f.write('<path stroke="#33c" fill="none" d="M0 0' + "".join(f"L{(i * 0.2):.1f} {(500 + 400 * math.sin(i / (40 + k))):.1f}" for i in range(19_999)) + '"/>')
        for i in range(20_000):
            f.write(f'<circle cx="{(i * 0.2) % 4000:.1f}" cy="{(i * 37) % 1000}" r="2" fill="#c33"/>')
        f.write("</svg>")
    # Embedded JSON: many large candidate regions.
    blob = json.dumps({"data": {"values": [{"a": i, "b": i * 2} for i in range(20_000)]}, "mark": "bar"})
    with open(os.path.join(d, "big-embedded.html"), "w") as f:
        f.write("<html><body>" + "".join(f"<script>var x{k} = {blob};</script>" for k in range(4)) + "</body></html>")


matplotlib_svgs()
matplotlib_pdfs()
vega_outputs()
office_files()
adversarial()
print("ok", OUT)
