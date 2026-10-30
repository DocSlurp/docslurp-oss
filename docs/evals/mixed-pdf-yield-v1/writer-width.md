# Writer margin-aligned table width

The observed reload value `115596` has a version-matched source explanation.
LibreOffice 26.8.1.1 imports FULL/NONE-aligned tables using its maximum internal
reference width, even when a width is specified. That constant is 65,535; the UNO
getter returns stored frame width with unit conversion. Converting 65,535 twips
to hundredths of a millimeter gives 2,774,315/24, rounded to 115,596. The independent
controls reproduce this path; it is not evidence of a 3,276-point rendered table.

Sources pinned to the version tag's peeled commit:

- [Maximum reference width](https://github.com/LibreOffice/core/blob/bf6ef2662401c7d6dce671ab4deb26ee0af3a7c1/sw/source/filter/xml/xmltbli.hxx#L89)
- [Margin/full import path](https://github.com/LibreOffice/core/blob/bf6ef2662401c7d6dce671ab4deb26ee0af3a7c1/sw/source/filter/xml/xmltbli.cxx#L2373)
- [UNO stored-width getter](https://github.com/LibreOffice/core/blob/bf6ef2662401c7d6dce671ab4deb26ee0af3a7c1/sw/source/core/unocore/unotbl.cxx#L269)

This explains the representation. It does not prove exact distribution-binary
source identity or correct candidate geometry. Keep the raw pre/post values and
the failed scalar-equality assertion. For this bounded margin-aligned,
non-relative, body-owned table case, verify realized geometry independently:

- Bind the exact editable document, drawing plan, readbacks, exported PDF and
  runtime. Rehash the ODT around reload/export.
- Resolve saved ODF styles, page area, margins, repeated columns, cells and spans.
  Cross-check per-row separators and every actual PDF column/row/cell.
- Check native text, padding/alignment, visible ink, clipping and overlaps against
  the pre-export physical plan. Preserve quantization diagnostics separately.
- Refuse unsupported orientation, relative width, nesting, ownership, missing
  dimensions, unexplained state changes or absent independent geometry evidence.

Do not force the getter, replace it with an expected value, erase the mismatch or
widen tolerances to fit observations. Multipage and overlapping cases require
their own evidence. The source explanation grants no fixture or corpus acceptance.
