# What PDF bytes can tell the auto router

Image subtraction is a storage diagnostic, not a count of missing text. The useful
quantity is original PDF bytes minus the sum of unique encoded image streams and
their masks. The residual still includes fonts, vector paths, content operators,
metadata, object tables and container overhead. Exported PNG/JPEG sizes are a
different quantity: exporting can decode or re-encode an image.

PDF page resources are shared. Attribute an object to every page that uses it,
but count its physical bytes once for document totals. Follow indirect font
descriptors to embedded font programs and image references to soft masks. Keep
referenced resources separate from images actually painted on the page. The
original object map and xref positions help explain storage; they do not establish
how many readable characters a page should contain.

QPDF can split pages and inspect objects, but rewriting reorganizes the file.
One-page files may duplicate resources that were shared in the original. Four-page
chunks retain some sharing, while dividing a chunk residual equally among its pages
is only an allocation convention. The experiment therefore measures split overhead,
storage multiplication and native-text equivalence separately. [QPDF CLI documentation](https://qpdf.readthedocs.io/en/stable/cli.html)

For routing, combine storage features with direct observations:

| Observation | What it supports | Important limitation |
| --- | --- | --- |
| Visible glyph count versus extracted characters | Suspected loss in the text layer | Ligatures, encoding and invisible text complicate the ratio |
| Union of placed image rectangles | How much page area may require OCR | A photograph and a document screenshot are different tasks |
| Invisible text and later opaque drawing operations | Suspected hidden or occluded extraction | Painting order and geometry require care |
| Vector paths with little usable text | Possible outlined text or diagrams | Ordinary illustrations also contain paths |
| Cheap OCR confidence and output quality signals | Whether another extraction tier may help | High confidence does not prove factual completeness |

Use consistent coordinates for these observations: image/text boxes and the rotated
page rectangle can use different coordinate systems. The implementation converts
the page boundary back to unrotated coordinates before coverage calculations.
[PyMuPDF page coordinates](https://pymupdf.readthedocs.io/en/latest/page.html)

Text-trace glyphs, opacity, rendering mode and drawing sequence numbers provide
evidence about visibility and painting order. They are useful features rather than
a universal expected-byte formula. [PyMuPDF low-level functions](https://pymupdf.readthedocs.io/en/latest/functions.html)

The proposed 20% threshold remains a candidate until measured. Its denominator must
be named: glyph yield, prose-section raster share, image area and hard-page fraction
are four distinct quantities. In this corpus, a 20% hard-page document has two hard
pages out of ten; it need not have 20% of its bytes or page area in images.

No production savings or optimal threshold is established by this methodology.
The final evidence must combine untouched held-out quality with fresh randomized
timing. Hosted-model dollar savings require actual priced calls and usage receipts;
local elapsed time alone cannot establish them.
