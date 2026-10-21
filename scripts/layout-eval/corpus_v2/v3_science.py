"""V3 scientific pages: numbered display math, inline math, matrices/cases (KaTeX), figure, table.

Prose, data and equations are newly authored teaching material; standard identities only.
No real study or publication is claimed.
"""
import math

try:
    from .page_v3 import PageV3
except ImportError:
    from page_v3 import PageV3


def detection_paper():
    p = PageV3('v3-paper-occupancy-estimation', 1275, 1650, cluster='v3-paper-occupancy-estimation',
               features=['two-column', 'formula-display', 'formula-number', 'formula-inline', 'chart-line', 'table-booktabs', 'references', 'footnote', 'abstract'],
               brief='Two-column methods paper: abstract, numbered display equations with formula numbers, inline math, figure with caption, booktabs table, references.',
               paper='#ffffff')
    ink = '#1a1a1a'
    p.text('Journal of Field Methods · Vol. 12 · pp. 211–224', 80, 40, 700, 13, 'serif-italic', '#555555', label='header')
    p.text('Short communication', 1000, 40, 195, 13, 'serif-italic', '#555555', label='header')
    p.text('Estimating site occupancy when detection is imperfect', 80, 80, 1115, 34, 'serif-bold', ink, label='title')
    p.text('R. Okafor¹ and L. Brandt²', 80, 132, 1115, 18, 'serif', '#333333', label='paragraph', kind='authors')
    p.text('¹ Department of Ecology, fictional university   ² Survey Statistics Unit, fictional institute', 80, 160, 1115, 13, 'serif-italic', '#555555', label='paragraph', kind='affiliations')
    p.rectangle([80, 195, 1195, 305], '#f3f3f0')
    p.text('Abstract. A species can be present at a site and still be missed on a single visit. We show how repeated visits separate occupancy from detection, derive the maximum-likelihood estimator for the simplest constant-probability model, and compare its precision with the naive proportion of sites where the species was seen. With three visits per site the corrected estimate is unbiased for detection probabilities above about 0.3.', 98, 210, 1080, 16, 'serif', '#222222', leading=23)
    col1, col2, cw = 80, 658, 537
    def display(latex, y, number, size=13, indent=30):
        """Numbered display equation; the number is centred on the formula's vertical extent."""
        before = len(p.source['regions'])
        bottom = p.equation(latex, col1 + indent, y, cw - indent - 45, size=size)
        box = p.source['regions'][before]['bbox']
        p.text(number, col1 + cw - 32, (box[1] + box[3]) / 2 - 9, 32, 16, 'serif', ink, label='formula_number')
        return bottom + 18

    y = p.text('1  Model', col1, 340, cw, 20, 'serif-bold', ink, label='title') + 10
    y = p.text('Let each of S sites be occupied with probability ψ, and let an occupied site yield a detection on each of K visits with probability p, independently. For a site with d detections, the likelihood contribution is', col1, y, cw, 17, 'serif', ink, leading=25) + 14
    y = display(r'L_i(\psi,p)=\psi\binom{K}{d_i}p^{d_i}(1-p)^{K-d_i}+(1-\psi)\,\mathbb{1}[d_i=0],', y, '(1)', indent=10)
    y = p.text('where the indicator term accounts for unoccupied sites, which can only produce zero detections. The full likelihood is the product over sites,', col1, y, cw, 17, 'serif', ink, leading=25) + 14
    y = display(r'\ell(\psi,p)=\sum_{i=1}^{S}\log L_i(\psi,p).', y, '(2)', indent=120)
    y = p.inline_math('Writing ', r'S_d', ' for the number of sites with at least one', col1, y, cw, 17, 'serif', ink)
    y = p.text('detection and D for the total number of detections among them, the estimates solve the score equations jointly. A convenient closed form exists for ψ given p:', col1, y, cw, 17, 'serif', ink, leading=25) + 14
    y = display(r'\hat{\psi}=\frac{S_d}{S\,\left[1-(1-\hat{p})^{K}\right]}.', y, '(3)', indent=130)
    y = p.text('The denominator is the probability that an occupied site is detected at least once, so (3) inflates the naive proportion by exactly the share of occupied sites that are missed.', col1, y, cw, 17, 'serif', ink, leading=25) + 30
    y = p.text('2  Precision', col1, y, cw, 20, 'serif-bold', ink, label='title') + 10
    y = p.text('The asymptotic variance follows from the observed information. For large S and moderate p, a useful approximation is', col1, y, cw, 17, 'serif', ink, leading=25) + 14
    y = display(r'\mathrm{Var}(\hat{\psi})\approx\frac{\psi(1-\psi)}{S}+\frac{\psi\,(1-p^{*})}{S\,p^{*}},\qquad p^{*}=1-(1-p)^{K}.', y, '(4)', indent=0)
    y = p.text('The second term is the price of imperfect detection; it vanishes as p* approaches one.', col1, y, cw, 17, 'serif', ink, leading=25)
    if y > 1500:
        raise ValueError('Column 1 overflow')
    p.text('Simulation', col2, 340, cw, 20, 'serif-bold', ink, label='title')
    p.text('We simulated 2,000 surveys of 120 sites with ψ = 0.6 for a range of detection probabilities and compared the naive proportion with the estimator (3).', col2, 390, cw, 17, 'serif', ink, leading=25)
    ps = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]
    naive = [round(0.6 * (1 - (1 - q) ** 3), 2) for q in ps]
    corrected = [0.41, 0.52, 0.58, 0.6, 0.6, 0.6, 0.6, 0.6, 0.6]
    p.chart_v3([col2, 490, col2 + cw, 860], 'line', [f'{q:.1f}' for q in ps], {'Naive proportion': naive, 'Estimator (3)': corrected},
               y_max=0.8, ticks=4, y_label='Mean estimate of ψ', x_label='Detection probability p', colors=['#999999', '#1f4e79'], panel='#fafafa', size=13)
    p.text('Figure 1. Mean estimates over 2,000 simulated surveys (K = 3, ψ = 0.6). The naive proportion equals ψp* in expectation.', col2, 872, cw, 14, 'serif', '#333333', leading=20, label='caption')
    p.text('Table 1. Root mean squared error of each estimator, K = 3.', col2, 950, cw, 14, 'serif', '#333333', label='caption')
    rmse = [('0.2', '0.33', '0.17'), ('0.4', '0.17', '0.09'), ('0.6', '0.07', '0.06'), ('0.8', '0.05', '0.05')]
    p.table_v3([col2, 978, col2 + cw, 978 + 5 * 28], [[('p', 1), ('Naive', 1), ('Estimator (3)', 1)]], [list(r) for r in rmse], [.3, .35, .35],
               rules='booktabs', align=['left', 'right', 'right'], row_height=28, face='serif', size=15, header_face='serif-bold')
    p.text('Below p ≈ 0.3 the estimator is itself biased low, because many surveys contain too few detections to estimate p. A fourth visit removes most of that bias¹.', col2, 1140, cw, 17, 'serif', ink, leading=25)
    p.text('References', col2, 1250, cw, 18, 'serif-bold', ink, label='title')
    p.text('[1] Author A., Author B. (2002) Estimating occupancy rates when detection probabilities are less than one. Fictional Ecology 83, 2248–2255.\n[2] Author C. (2006) Occupancy estimation and modelling. Fictional Press.\n[3] Author D., Author E. (2019) Designing repeat surveys. Methods Notes 4, 15–29.', col2, 1285, cw, 14, 'serif', '#333333', leading=21, label='list', kind='references')
    p.line([80, 1520, 400, 1520], '#888888', 1)
    p.text('¹ With K = 4 and p = 0.2 the mean estimate was 0.55 in a further 2,000 simulated surveys.', 80, 1530, 1115, 13, 'serif', '#444444', label='footnote')
    p.text('212', 600, 1595, 75, 15, 'serif', '#444444', label='footer')
    return p


def linear_systems_notes():
    p = PageV3('v3-lecture-notes-linear-systems', 1240, 1754, cluster='v3-lecture-notes-linear-systems',
               features=['formula-display', 'formula-matrix', 'formula-cases', 'formula-number', 'formula-inline', 'theorem-box', 'margin-note', 'header', 'footer'],
               brief='Single-column lecture notes: KaTeX matrices and piecewise cases, numbered displays, shaded theorem box, worked example, margin note.',
               paper='#fffef9')
    ink = '#1d2230'
    accent = '#7a2e2e'
    p.text('MATH 2140 · Numerical Linear Algebra', 90, 45, 700, 15, 'sans-bold', '#5a6070', label='header')
    p.text('Lecture 9', 1060, 45, 100, 15, 'sans', '#5a6070', label='header')
    p.line([90, 75, 1150, 75], '#c9c3b5', 1)
    p.text('9.2  Tridiagonal systems', 90, 100, 900, 34, 'palatino-bold', ink, label='title')
    p.text('Discretising a two-point boundary value problem on n interior points leads to a linear system whose matrix has non-zeros only on three diagonals. For the model problem with unit spacing,', 90, 160, 900, 19, 'palatino', ink, leading=29)
    p.equation(r'A=\begin{pmatrix}2 & -1 & & \\ -1 & 2 & \ddots & \\ & \ddots & \ddots & -1\\ & & -1 & 2\end{pmatrix},\qquad A\mathbf{u}=\mathbf{f}.', 250, 255, 640, size=20, engine='katex')
    p.text('(9.4)', 940, 320, 50, 18, 'palatino', ink, label='formula_number')
    p.text('Storing only the three diagonals needs 3n − 2 numbers instead of n². More importantly, Gaussian elimination without pivoting creates no fill-in.', 90, 450, 900, 19, 'palatino', ink, leading=29)
    p.rectangle([90, 545, 990, 800], '#f1ece0')
    p.line([90, 545, 90, 800], accent, 4)
    p.text('Theorem 9.1 (Thomas algorithm)', 115, 562, 860, 19, 'palatino-bold', accent, label='title')
    p.text('If A is tridiagonal with sub-, main and super-diagonals a, b, c and is strictly diagonally dominant, then elimination is stable and the modified coefficients are', 115, 597, 860, 18, 'palatino-italic', ink, leading=27)
    p.equation(r'c_i^{\prime}=\begin{cases}\dfrac{c_1}{b_1}, & i=1,\\[6pt] \dfrac{c_i}{b_i-a_i c_{i-1}^{\prime}}, & i=2,\dots,n-1.\end{cases}', 280, 662, 560, size=17, engine='katex')
    p.text('(9.5)', 910, 690, 50, 18, 'palatino', ink, label='formula_number')
    p.text('The forward sweep and the back substitution each cost O(n) operations, so the whole solve is linear in n.', 90, 830, 900, 19, 'palatino', ink, leading=29)
    p.text('Example', 90, 900, 300, 22, 'palatino-bold', ink, label='title')
    p.text('Take n = 3 and right-hand side f = (1, 0, 1). The augmented system and its reduced form are', 90, 937, 900, 19, 'palatino', ink, leading=29)
    p.equation(r'\def\arraystretch{1.5}\left(\begin{array}{ccc|c}2&-1&0&1\\-1&2&-1&0\\0&-1&2&1\end{array}\right)\;\longrightarrow\;\left(\begin{array}{ccc|c}1&-\tfrac12&0&\tfrac12\\0&1&-\tfrac23&\tfrac13\\0&0&1&1\end{array}\right),', 120, 1000, 860, size=18, engine='katex')
    p.text('(9.6)', 1000, 1075, 50, 18, 'palatino', ink, label='formula_number')
    p.text('so back substitution gives u = (1, 1, 1). Checking against (9.4): 2 − 1 = 1, −1 + 2 − 1 = 0 and −1 + 2 = 1.', 90, 1190, 900, 19, 'palatino', ink, leading=29)
    p.text('Conditioning', 90, 1270, 300, 22, 'palatino-bold', ink, label='title')
    p.text('The eigenvalues of the model matrix are known in closed form, which gives its condition number directly:', 90, 1307, 900, 19, 'palatino', ink, leading=29)
    p.equation(r'\lambda_k=2-2\cos\frac{k\pi}{n+1},\qquad \kappa_2(A)=\frac{\lambda_n}{\lambda_1}\approx\frac{4(n+1)^2}{\pi^2}.', 220, 1370, 700, size=14)
    p.text('(9.7)', 1000, 1385, 50, 18, 'palatino', ink, label='formula_number')
    p.text('Halving the grid spacing therefore roughly quadruples the condition number, although the solve itself remains exact up to rounding.', 90, 1465, 900, 19, 'palatino', ink, leading=29)
    p.text('Margin note. For periodic boundary conditions the matrix gains corner entries; see the cyclic variant in §9.4.', 1010, 545, 160, 14, 'sans-italic', '#6a5f4a', leading=20, label='paragraph', kind='margin-note')
    p.line([90, 1650, 1150, 1650], '#c9c3b5', 1)
    p.text('Authored lecture notes for a layout test · not course material of any real institution', 90, 1665, 800, 13, 'sans', '#7a7f8a', label='footer')
    p.text('9–3', 1110, 1662, 40, 15, 'sans', '#5a6070', label='footer')
    return p


def build():
    return [detection_paper(), linear_systems_notes()]
