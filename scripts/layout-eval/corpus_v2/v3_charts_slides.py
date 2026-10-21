"""V3 chart-rich report pages and presentation slides. Data are authored and fictional."""
import random

try:
    from .page_v3 import PageV3
except ImportError:
    from page_v3 import PageV3

MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']


def energy_bulletin():
    p = PageV3('v3-chart-energy-bulletin', 1240, 1754, cluster='v3-chart-energy-bulletin',
               features=['chart-line', 'chart-stacked-bar', 'legend', 'axis-labels', 'key-figures', 'two-column', 'header', 'footer'],
               brief='Statistical bulletin: KPI strip, two-series line chart, stacked-bar generation mix, explanatory prose, notes.',
               paper='#ffffff')
    ink = '#1b2a33'
    teal = '#0f6e6e'
    p.rectangle([0, 0, 1240, 14], teal)
    p.text('Energy Trends Bulletin', 70, 44, 600, 24, 'sans-bold', teal, label='header')
    p.text('Issue 10 · Published 21 October 2026', 820, 50, 350, 15, 'sans', '#55636b', label='header')
    p.text('Electricity demand fell for a third year while wind output reached a record', 70, 100, 1100, 36, 'sans-bold', ink, leading=44, label='title')
    demand_2025 = [22.1, 20.3, 20.6, 18.4, 17.6, 16.5, 16.9, 16.8, 17.2, 19.0, 20.8, 22.5]
    demand_2026 = [21.4, 19.6, 19.9, 17.8, 17.0, 16.1, 16.6, 16.4, 16.7, 18.6, 20.5, 22.0]
    quarters = ['Q4 2025', 'Q1 2026', 'Q2 2026', 'Q3 2026']
    mix = {'Wind': [29.5, 27.0, 33.1, 38.6], 'Gas': [31.0, 28.4, 24.9, 22.3], 'Nuclear': [14.2, 15.0, 14.6, 13.8], 'Solar': [3.1, 9.8, 11.4, 6.9], 'Other': [8.6, 7.9, 6.8, 7.4]}
    q3_total = sum(v[3] for v in mix.values())
    kpis = [(f'{sum(demand_2026):.1f} TWh', 'Demand, 12 months to December'), (f'{mix["Wind"][3] / q3_total * 100:.1f}%', 'Wind share of generation, Q3 2026'),
            (f'{(mix["Gas"][3] - mix["Gas"][2]) / mix["Gas"][2] * 100:.1f}%'.replace('-', '−'), 'Gas-fired output, Q3 on Q2')]
    for i, (value, caption) in enumerate(kpis):
        x = 70 + i * 375
        p.rectangle([x, 210, x + 350, 320], '#eef5f5')
        p.text(value, x + 20, 225, 310, 34, 'sans-bold', teal, label='paragraph', kind='key-figure')
        p.text(caption, x + 20, 278, 310, 15, 'sans', '#3d4b52', label='caption')
    p.text('Monthly demand', 70, 365, 540, 22, 'sans-bold', ink, label='title')
    p.text('Demand was below the previous year in every month. The gap was largest in the first quarter, when a mild winter reduced heating load.', 70, 400, 540, 17, 'serif', '#333333', leading=25)
    p.chart_v3([70, 480, 1170, 900], 'line', MONTHS, {'2025': demand_2025, '2026 (provisional)': demand_2026}, title='Figure 1  Electricity demand, TWh per month',
               y_label='TWh', y_max=25, colors=['#9aa8b1', teal], panel='#f7f9f9')
    p.chart_v3([70, 940, 760, 1420], 'stacked-bar', quarters, mix, title='Figure 2  Generation by source, TWh',
               y_label='TWh', y_max=90, colors=['#0f6e6e', '#d08c3a', '#6b5b95', '#e0c341', '#9aa8b1'], panel='#f7f9f9', size=13)
    p.text('Generation mix', 800, 940, 370, 22, 'sans-bold', ink, label='title')
    p.text('Wind output in the third quarter was the highest for any quarter on record, helped by new offshore capacity at two sites. Gas-fired generation fell to its lowest third-quarter level since the series began. Solar output peaked in the second quarter, as expected.', 800, 978, 370, 17, 'serif', '#333333', leading=25)
    p.text('Imports and storage are included in "Other". Quarterly totals differ from monthly demand because of exports and network losses.', 800, 1250, 370, 14, 'serif-italic', '#555555', leading=21, label='footnote')
    p.text('Table 1  Generation by source, TWh', 70, 1440, 700, 17, 'sans-bold', ink, label='caption')
    rows = [[name] + [f'{v:.1f}' for v in values] for name, values in mix.items()]
    rows.append(['Total'] + [f'{sum(v[i] for v in mix.values()):.1f}' for i in range(4)])
    p.table_v3([70, 1468, 760, 1468 + 7 * 24], [[('Source', 1)] + [(q, 1) for q in quarters]], rows, [.28, .18, .18, .18, .18], rules='booktabs',
               row_height=24, face='sans', size=14, row_roles=['data'] * 5 + ['total'])
    p.text('Notes', 800, 1440, 300, 17, 'sans-bold', ink, label='title')
    p.text('2026 figures are provisional and will be revised in the annual digest. All figures are authored for a layout test and do not describe any real electricity system.', 800, 1480, 370, 14, 'serif', '#444444', leading=21)
    p.line([70, 1660, 1170, 1660], '#c9d2d6', 1)
    p.text('Energy Trends Bulletin · fictional statistics office', 70, 1675, 700, 13, 'sans', '#6b7880', label='footer')
    p.text('3', 1150, 1672, 20, 15, 'sans', '#6b7880', label='footer')
    return p


def survey_findings():
    p = PageV3('v3-chart-commuter-survey', 1240, 1754, cluster='v3-chart-commuter-survey',
               features=['chart-pie', 'chart-scatter', 'chart-hbar', 'legend', 'axis-labels', 'pull-quote', 'two-column', 'footer'],
               brief='Survey findings page: pie with legend, two-group scatter with axis titles, horizontal bars, pull quote and two-column prose.',
               paper='#fbfaf7')
    ink = '#2b2420'
    plum = '#7b3f61'
    p.text('TRAVEL TO WORK SURVEY 2026 · FINDINGS', 70, 48, 800, 15, 'gothic-bold', plum, label='header')
    p.text('How people get to work', 70, 90, 1100, 46, 'palatino-bold', ink, label='title')
    p.text('2,184 employees at eleven sites answered the survey in May. Respondents described their usual journey, its length and how long it took.', 70, 160, 1100, 19, 'palatino', '#4a403a', leading=28)
    modes = ['Car, alone', 'Bus', 'Cycle', 'Walk', 'Train', 'Car share']
    shares = [41, 18, 14, 11, 10, 6]
    p.chart_v3([70, 240, 640, 640], 'pie', modes, {'Share of respondents': shares}, title='Main mode of travel, %', unit='%',
               colors=['#7b3f61', '#d9822b', '#3f7d58', '#c9b458', '#3c6e9e', '#9c8f86'], panel='#f2eee8')
    rng = random.Random(20261021)
    cyclists = [(round(d, 1), round(4 + d * 3.6 + rng.uniform(-5, 6))) for d in [rng.uniform(1, 14) for _ in range(28)]]
    drivers = [(round(d, 1), round(9 + d * 1.6 + rng.uniform(-6, 12))) for d in [rng.uniform(2, 30) for _ in range(34)]]
    p.chart_v3([680, 240, 1170, 640], 'scatter', (0, 30), {'Cycle': cyclists, 'Car, alone': drivers}, title='Distance and journey time',
               y_label='Minutes', x_label='Distance, km', y_max=70, colors=['#3f7d58', '#7b3f61'], panel='#f2eee8', size=13)
    p.text('Short trips are mostly driven', 70, 690, 540, 25, 'palatino-bold', ink, label='title')
    p.text('Four in ten respondents drive alone, and a third of those live less than five kilometres from their site. For these short trips, cycling times in the survey were similar to driving times once parking is included.', 70, 735, 540, 18, 'palatino', '#3a312c', leading=28)
    p.text('Most cyclists ride less than ten kilometres, and their journey time rises steadily with distance. Driving times vary much more, reflecting congestion at the two city-centre sites.', 70, 905, 540, 18, 'palatino', '#3a312c', leading=28)
    p.rectangle([630, 690, 1170, 880], '#f2e6ec')
    p.line([650, 712, 650, 858], plum, 4)
    p.text('“If the showers worked and there was somewhere dry to leave a bike, I would cycle three days a week.”', 670, 712, 480, 22, 'palatino-italic', plum, leading=32, label='paragraph', kind='pull-quote')
    p.text('Respondent, Riverside depot', 670, 838, 480, 14, 'gothic', '#6a5560', label='caption')
    barriers = ['Unsafe junctions', 'No secure parking', 'Distance', 'Weather', 'No showers', 'Need car for work']
    p.text('What stops people cycling', 630, 920, 540, 22, 'palatino-bold', ink, label='title')
    p.chart_v3([630, 960, 1170, 1300], 'hbar', barriers, {'% citing': [47, 39, 33, 31, 24, 18]}, unit='%', colors=['#7b3f61'], panel='#f2eee8', size=14)
    p.text('Respondents could choose up to three reasons. Base: 1,712 people who do not cycle to work.', 630, 1312, 540, 13, 'gothic', '#6a5560', leading=19, label='caption')
    p.text('Next steps', 70, 1080, 540, 25, 'palatino-bold', ink, label='title')
    p.text('The facilities group will publish site plans for covered cycle parking in the new year, starting with the depots where demand is highest. A follow-up survey in 2027 will measure any change.', 70, 1125, 540, 18, 'palatino', '#3a312c', leading=28)
    sites = [('Riverside depot', 412, 52, 9), ('Harbour office', 298, 28, 25), ('North works', 355, 58, 6), ('City centre hub', 506, 23, 21), ('Eastgate store', 237, 47, 12), ('Other sites (6)', 376, 44, 13)]
    total = sum(s[1] for s in sites)
    car_all, cycle_all = (round(sum(s[1] * s[k] for s in sites) / total) for k in (2, 3))
    if total != 2184 or (car_all, cycle_all) != (shares[0], shares[2]):
        raise ValueError('Survey site table disagrees with the pie chart')
    p.text('Table 1  Responses and main mode by site', 70, 1400, 1100, 17, 'gothic-bold', ink, label='caption')
    rows = [[name, f'{n:,}', f'{car}%', f'{cyc}%'] for name, n, car, cyc in sites]
    rows.append(['All sites', f'{total:,}', f'{car_all}%', f'{cycle_all}%'])
    p.table_v3([70, 1430, 1170, 1430 + 8 * 26], [[('Site', 1), ('Respondents', 1), ('Car, alone', 1), ('Cycle', 1)]], rows, [.4, .2, .2, .2],
               rules='horizontal', row_height=26, face='gothic', size=14, row_roles=['data'] * 6 + ['total'], rule_color='#cbbfb6')
    p.line([70, 1660, 1170, 1660], '#d6cdc6', 1)
    p.text('Fictional employer survey; authored layout specimen. Percentages may not total 100 because of rounding.', 70, 1675, 1000, 13, 'gothic', '#7a6e66', label='footer')
    return p


def slide_quarterly():
    p = PageV3('v3-slide-quarterly-review', 1600, 900, cluster='v3-slide-quarterly-review',
               features=['slide', 'chart-grouped-bar', 'bullets', 'logo', 'footer', 'slide-number'],
               brief='16:9 business slide: title, bullet list, grouped bar chart with legend, logo and slide footer.',
               paper='#ffffff')
    navy = '#16325c'
    p.rectangle([0, 0, 1600, 8], '#f28c28')
    p.text('Q3 support performance', 70, 50, 1200, 50, 'sans-bold', navy, label='title')
    p.text('Faster first replies, but backlog grew in September', 72, 118, 1200, 26, 'sans', '#5d6b7e')
    p.text('• Median first reply: 2 h 10 min (Q2: 3 h 05 min)\n• Tickets resolved in one contact: 64%\n• Backlog over 7 days rose to 312 tickets\n• Two new hires start in November', 72, 210, 600, 25, 'sans', '#26364d', leading=52, label='list')
    p.chart_v3([720, 190, 1530, 760], 'grouped-bar', ['Jul', 'Aug', 'Sep'], {'Opened': [4120, 3980, 4650], 'Resolved': [4210, 4040, 4310]},
               title='Tickets opened and resolved', y_max=5000, colors=['#9db4d3', navy], panel='#f5f7fa', size=16, value_labels=True)
    p.ellipse([70, 800, 110, 840], '#f28c28')
    p.ellipse([82, 812, 98, 828], '#ffffff')
    p.text('Halden', 120, 806, 150, 22, 'sans-bold', navy, label=None)
    p.region('logo', [70, 800, 205, 840], None, kind='authored-ring-wordmark')
    p.text('Customer operations review · Internal', 600, 812, 600, 16, 'sans', '#8090a5', label='footer')
    p.text('7', 1510, 808, 20, 20, 'sans-bold', navy, label='footer')
    return p


def slide_seminar():
    p = PageV3('v3-slide-diffusion-seminar', 1600, 900, cluster='v3-slide-diffusion-seminar',
               features=['slide', 'formula-display', 'formula-number', 'illustration', 'bullets', 'footer', 'dark-background'],
               brief='Dark 16:9 seminar slide: numbered display equation, explanatory bullets, authored concentration-profile diagram.',
               paper='#11202b')
    p.text('Diffusion from a point source', 70, 50, 1300, 46, 'sans-bold', '#f2f5f7', label='title')
    p.text('Lecture 6 · Transport phenomena', 72, 112, 800, 22, 'sans', '#8fb3c7')
    p.rectangle([70, 180, 840, 330], '#1b3140')
    p.equation(r'c(x,t)=\frac{M}{\sqrt{4\pi D t}}\,\exp\!\left(-\frac{x^{2}}{4Dt}\right)', 100, 205, 640, size=26, ink='#f2f5f7')
    p.text('(6.3)', 765, 240, 60, 22, 'sans', '#c9d6de', label='formula_number')
    p.text('• Total mass M is conserved for every t\n• Width grows like √(Dt), not like t\n• Peak height falls like 1/√t\n• Superpose sources for any initial profile', 72, 380, 760, 26, 'sans', '#dbe5eb', leading=54, label='list')
    x0, y0, x1, y1 = 900, 180, 1530, 760
    p.rectangle([x0, y0, x1, y1], '#162a37')
    import math
    base = 700
    p.line([930, base, 1500, base], '#8fb3c7', 2)
    p.line([1215, 220, 1215, base], '#3c5a6c', 1)
    for t, color in ((1, '#f28c28'), (4, '#e0c341'), (12, '#5fc1b5')):
        pts = []
        for i in range(121):
            x = -6 + 12 * i / 120
            c = math.exp(-x * x / (4 * t)) / math.sqrt(4 * math.pi * t)
            pts.extend([1215 + x * 45, base - c * 1500])
        p.line(pts, color, 4)
    p.text('t = 1', 1255, 290, 80, 18, 'sans', '#f28c28', label=None)
    p.text('t = 4', 1320, 470, 80, 18, 'sans', '#e0c341', label=None)
    p.text('t = 12', 1400, 590, 90, 18, 'sans', '#5fc1b5', label=None)
    p.text('x', 1490, 708, 20, 18, 'sans', '#8fb3c7', label=None)
    p.text('c', 1225, 222, 20, 18, 'sans', '#8fb3c7', label=None)
    p.region('illustration', [x0, y0, x1, y1], None, kind='authored-concentration-profiles', drawn_from='equation 6.3 with M = 1, D = 1')
    p.text('Profiles drawn from (6.3) with M = D = 1', 900, 775, 630, 16, 'sans', '#8fb3c7', label='caption')
    p.text('Department of Chemical Engineering · authored teaching slide', 70, 850, 800, 15, 'sans', '#6f8a99', label='footer')
    p.text('14 / 31', 1460, 850, 70, 15, 'sans', '#6f8a99', label='footer')
    return p


def build():
    return [energy_bulletin(), survey_findings(), slide_quarterly(), slide_seminar()]
