"""Two source-authored scientific pilots with reproducible Mathtext formula assets.

Inspiration PDFs and their inspected page captures remain external. Prose,
illustrations and illustrative data below are newly authored. No real experiment
or publication is claimed. Rendering requires matplotlib==3.10.7 and Pillow.
"""
from pathlib import Path
import hashlib
import json
import math
import os
try:
    from .page import Page,poly
except ImportError:
    from page import Page,poly

REFERENCE_ROOT=Path('/home/dan/data/docslurp-evals/reference-inspiration-v2/scientific')
OPENSTAX='https://d3bxy9euw4e147.cloudfront.net/oscms-prodcms/media/documents/UniversityPhysicsVolume1-LR.pdf'
NASA='https://ntrs.nasa.gov/api/citations/19960002145/downloads/19960002145.pdf'


def equation(p,latex,x,y,width,size=23,display=True,group=None,component=False):
    """Render actual mathematical typesetting, preserve expression and tight ink."""
    os.environ.setdefault('MPLCONFIGDIR',str(Path.home()/'.cache/docslurp/matplotlib'))
    import matplotlib
    matplotlib.use('Agg')
    from matplotlib.mathtext import math_to_image
    from matplotlib.font_manager import FontProperties
    from PIL import Image,ImageChops
    root=REFERENCE_ROOT/'authored-math-assets';root.mkdir(parents=True,exist_ok=True)
    background=p.source['paper']
    for command in p.source['commands']:
        if command['op']=='rect' and command.get('fill'):
            x0,y0,x1,y1=command['bbox']
            if x0<=x<=x1 and y0<=y<=y1:background=command['fill']
    digest=hashlib.sha256(f'{latex}|{size}|{background}|mathtext-3.10.7'.encode()).hexdigest()
    path=root/f'{digest}.png'
    if not path.exists():
        with matplotlib.rc_context({'savefig.facecolor':background,'figure.facecolor':background}):
            math_to_image('$'+latex+'$',path,dpi=144,format='png',color='#172a32',
                          prop=FontProperties(size=size,math_fontfamily='stix'))
        im=Image.open(path).convert('RGB');b=ImageChops.difference(im,Image.new('RGB',im.size,background)).getbbox()
        if not b:raise ValueError('Empty formula rendering')
        im.crop(b).save(path)
    licenses=REFERENCE_ROOT/'math-rendering-license-receipts';licenses.mkdir(exist_ok=True)
    fontroot=Path(matplotlib.get_data_path())/'fonts/ttf'
    mpllicense=Path(matplotlib.__file__).parent.parent/f'matplotlib-{matplotlib.__version__}.dist-info/LICENSE'
    license_receipts=[]
    for source in (fontroot/'LICENSE_STIX',fontroot/'LICENSE_DEJAVU',mpllicense):
        target=licenses/('MATPLOTLIB-LICENSE' if source==mpllicense else source.name)
        target.write_bytes(source.read_bytes())
        license_receipts.append({'path':str(target),'sha256':hashlib.sha256(target.read_bytes()).hexdigest()})
    fonts=[{'path':str(f),'sha256':hashlib.sha256(f.read_bytes()).hexdigest()} for f in sorted(fontroot.glob('STIX*.ttf'))]
    provenance={'schema':'authored-formula-raster-provenance-v1','kind':'standard-mathematical-typesetting-not-AI-image-generation',
        'expression':latex,'expression_sha256':hashlib.sha256(latex.encode()).hexdigest(),
        'image_sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'original_expression_declaration':'Newly authored formula expression for this original teaching example; standard mathematical identities, no source page raster copied.',
        'renderer':{'name':'matplotlib.mathtext','version':matplotlib.__version__,'fontset':'stix','dpi':144,'point_size':size,'background':background},
        'fonts':fonts,'license_receipts':license_receipts,'rights':'Original authored raster for user publication; STIX font software uses SIL OFL1.1; retain bundled license receipts.'}
    Path(str(path)+'.provenance.json').write_text(json.dumps(provenance,indent=2)+'\n')
    with Image.open(path) as im:w,h=im.size
    scale=min(1,width/w);w,h=w*scale,h*scale
    box=[x,y,x+w,y+h]
    if box[2]>p.width or box[3]>p.height:raise ValueError('Formula outside page')
    asset={'kind':'newly-authored-mathtext-typesetting','renderer':'matplotlib.mathtext',
        'renderer_version':matplotlib.__version__,'fontset':'stix','latex':latex,'dpi':144,
        'provenance_path':str(Path(str(path)+'.provenance.json'))}
    if component:
        p.math_component(path,box,latex,asset=asset,display=display,formula_group=group)
    else:
        p.image(path,box,label='formula',asset=asset,latex=latex,display=display,formula_group=group,extent_policy='cropped-rendered-formula-ink')
    return y+h


def inline(p,prefix,latex,suffix,x,y,width,size=23):
    """An inline formula has its own exact raster extent and prose linkage."""
    f=p.font('serif',size);left=f.getlength(prefix)
    p.text(prefix,x,y,width,size,'serif',label='paragraph',inline_group=f'{p.id}-{y}')
    before=len(p.source['regions']);end=equation(p,latex,x+left+6,y+3,width-left-6,size=12,display=False)
    formula=p.source['regions'][before];right=formula['bbox'][2]+8
    p.text(suffix,right,y,width-(right-x),size,'serif',label='paragraph',inline_group=f'{p.id}-{y}')
    return max(end,y+size*1.3)


def oscillation_lesson():
    p=Page('scientific-phase-and-oscillation',1320,1760,paper='#fffefa')
    green='#1c6156';ink='#1e3038';orange='#ba572c'
    p.source['inspiration']=[{'url':OPENSTAX,'work':'University Physics Volume 1','authors':['Samuel J. Ling','Jeff Sanny','William Moebs'],
        'pdf_pages':[756,759],'printed_pages':[746,749],'license':'CC BY 4.0 as stated in pinned 2018 PDF p4',
        'relationship':'General textbook hierarchy, colored figure captions, equation/diagram/prose rhythm; no page image or prose copied.'}]
    p.text('7  /  OSCILLATIONS & MODELS',70,42,1190,18,'sans-bold',green,label='header')
    p.line([70,91,1250,91],green,2)
    p.text('Phase is part of the initial condition',70,119,1180,51,'serif-bold',ink,label='title')
    p.text('A spring oscillator can begin anywhere in its cycle.',72,199,1180,27,'serif-italic',green)
    p.text('Displacement alone does not specify the motion. A block passing through its equilibrium position can move in either direction; the initial velocity resolves that ambiguity. The phase records both pieces of information in one periodic model [1].',72,270,890,25,'serif',ink,leading=32)
    inline(p,'Write the motion as',r'x(t)=A\cos(\omega t+\phi)','. Then differentiate:',72,440,900,25)
    p.rectangle([72,504,965,746],'#eef4ec')
    for i,expr in enumerate([r'x(t)\;=\; A\cos(\omega t+\phi)',r'v(t)\;=\;-A\omega\sin(\omega t+\phi)',r'a(t)\;=\;-A\omega^{2}\cos(\omega t+\phi)=-\omega^{2}x(t)']):
        equation(p,expr,105,530+i*66,790,size=22,group='kinematic-aligned-block')
    p.text('(7.4)',883,691,65,19,'serif',ink,label='caption')
    p.rectangle([1005,271,1250,744],'#fbefd8')
    p.text('A COMMON TRAP',1024,290,205,22,'narrow-bold',orange,label='title')
    p.text('Zero displacement does not imply zero velocity.',1024,340,205,23,'serif-bold',ink,leading=28)
    p.text('At equilibrium, the spring force vanishes for an instant. The block still carries kinetic energy and continues moving.',1024,451,205,21,'serif',ink,leading=27)
    equation(p,r'K=\frac{1}{2}mv^2',1024,620,205,17)
    # Independently authored mechanical diagram and waveform chart, not photographs.
    p.line([95,838,95,959],ink,5)
    spring=[]
    for i in range(25):spring.extend([100+i*12,894+(0 if i in (0,24) else (16 if i%2 else -16))])
    p.line(spring,green,3);p.rectangle([390,852,487,940],'#dce8e4',outline=ink,width=3)
    equation(p,r'm',426,875,45,19,display=False,component=True)
    p.line([95,950,531,950],ink,2);p.line([440,977,550,977],orange,3)
    p.line([550,977,537,969],orange,3);p.line([550,977,537,985],orange,3)
    equation(p,r'+x',505,991,70,14,display=False,component=True)
    p.region('illustration',[91,830,578,1030],None,kind='authored-spring-mass-schematic',not_a_photo=True)
    # Waveform has exactly specified axes, data coordinates and equation provenance.
    box=[660,808,1250,1045];p.rectangle(box,'#f3f5f0')
    p.line([707,924,1220,924],'#95a5a3',1);p.line([707,830,707,1014],'#95a5a3',1)
    coords=[]
    for i in range(151):
        t=i/150*2*math.pi;coords.extend([707+i/150*513,924-75*math.cos(t+math.pi/4)])
    p.line(coords,green,3)
    equation(p,r'x/A',672,819,60,12,display=False,component=True);equation(p,r'\omega t',1160,1004,65,12,display=False,component=True)
    p.region('chart',box,None,chart_kind='cosine-with-initial-phase',function_latex=r'x/A=\cos(\omega t+\pi/4)',domain=[0,2*math.pi],axis_labels=['angular time','normalized displacement'])
    p.text('FIGURE 7.2  A mechanical model and its displacement trace. The origin of time is selected before the positive turning point.',73,1065,1175,20,'sans',orange,label='caption')
    p.text('WORKED EXAMPLE  /  Recovering the phase',72,1142,1170,28,'sans-bold',green,label='title')
    p.text('An oscillator has amplitude 40 mm and angular frequency 5.0 rad/s. At the chosen origin of time its displacement is 20 mm and its velocity is negative. Find a phase consistent with these observations.',73,1198,1175,24,'serif',ink,leading=31)
    equation(p,r'\cos\phi=\frac{x_0}{A}=\frac{20}{40}=\frac{1}{2},\qquad v_0<0\Rightarrow\sin\phi>0',106,1330,1130,23,group='worked-example')
    equation(p,r'\therefore\;\phi=\frac{\pi}{3}\quad(\mathrm{mod}\;2\pi),\qquad v_0=-0.173\;\mathrm{m\,s^{-1}}',106,1408,1130,23,group='worked-example')
    p.text('CHECK  The signs of the displacement and velocity locate the phase in the first quadrant. A different time origin would change the phase, but not the amplitude or frequency.',73,1490,1170,21,'serif',ink,leading=27)
    p.line([73,1607,1250,1607],green,1)
    p.text('1. Phase is defined modulo one full cycle. Angles in the trigonometric model are measured in radians.',73,1621,1170,16,'serif',ink,label='footnote')
    p.text('[1] Ling, Sanny & Moebs. University Physics, vol. 1, §15.1 (OpenStax, 2018).',73,1656,1170,16,'serif',ink,label='paragraph',role='bibliographic-reference')
    p.text('Download for free at https://openstax.org/details/books/university-physics-volume-1.',73,1683,1170,15,'sans',green,label='footer')
    p.text('214',1193,1711,70,20,'mono',green,label='footer')
    return p


def heat_flux_note():
    p=Page('scientific-heat-flux-technical-note',1240,1754,paper='#ffffff');ink='#20282f';blue='#254b60'
    p.source['inspiration']=[{'url':NASA,'record_url':'https://ntrs.nasa.gov/citations/19960002145',
        'title':'Instrumentation development for study of Reynolds Analogy in reacting flows','author':'Dianne J. DeTurris','year':1995,
        'pdf_pages':[3],'rights':'NASA metadata copyright.determinationType=GOV_PUBLIC_USE_PERMITTED; distribution PUBLIC',
        'relationship':'Two-column research note, nomenclature, numbered equations and bracketed citations; original prose and hypothetical data, not a reproduction.'}]
    p.text('THERMAL MEASUREMENTS  /  TECHNICAL NOTE',75,42,1090,17,'sans-bold',blue,label='header')
    p.line([75,85,1165,85],blue,2)
    p.text('A paired-sensor estimate of wall heat flux',75,113,1090,43,'serif-bold',ink,label='title')
    p.text('M. Vale · R. Chen',75,184,1090,23,'serif',ink)
    p.text('Laboratory methods series   /   Analysis note 04   /   21 October 2026',75,223,1090,17,'sans',blue)
    p.text('Abstract',75,281,1060,24,'serif-bold',ink,label='title')
    p.text('A differential temperature pair provides a compact estimate of one-dimensional conductive heat flux. This note examines the propagation of calibration uncertainty through the temperature gradient. The worked values are illustrative and do not represent measured experimental results.',75,326,1090,23,'serif',ink,leading=29)
    p.line([75,449,1165,449],'#9caab3',1)
    lx,rx,w=75,650,515
    p.text('1. Measurement model',lx,480,w,27,'serif-bold',ink,label='title')
    p.text('A thin plate is approximated as homogeneous over the sensor separation. Heat flow is taken positive toward the cooled face. Fourier’s law then relates the local flux to the spatial temperature gradient [1].',lx,530,w,23,'serif',ink,leading=29)
    equation(p,r'q_x^{\prime\prime}=-k\frac{\partial T}{\partial x}',lx+64,687,390,24,group='measurement-model')
    p.text('(1)',lx+465,710,48,20,'serif',ink,label='caption')
    p.text('With two sensors, the gradient is replaced by a centered finite difference. The sign follows the orientation of the sensor coordinates, not the order of their electrical connections.',lx,773,w,23,'serif',ink,leading=29)
    equation(p,r'\widehat{q}^{\prime\prime}=k\frac{T_1-T_2}{\Delta x}',lx+64,938,390,23,group='measurement-model')
    p.text('(2)',lx+465,960,48,20,'serif',ink,label='caption')
    p.text('Nomenclature',lx,1044,w,25,'serif-bold',ink,label='title')
    specs=[(r'k','thermal conductivity'),(r'T_1,T_2','sensor temperatures'),(r'\Delta x','sensor separation'),(r'u_c','combined standard uncertainty')]
    for i,(symbol,desc) in enumerate(specs):
        yy=1097+i*48;equation(p,symbol,lx+6,yy,90,14,display=False);p.text(desc,lx+110,yy-2,w-110,19,'serif',ink)
    p.text('2. Propagating uncertainty',rx,480,w,27,'serif-bold',ink,label='title')
    p.text('Independent input uncertainties contribute through the local sensitivity coefficients. Correlation terms must be restored when sensors share a calibration reference.²',rx,530,w,23,'serif',ink,leading=29)
    equation(p,r'u_c^2(q)=\sum_{i=1}^{n}\left(\frac{\partial q}{\partial z_i}\right)^2u^2(z_i)',rx+17,681,475,21,group='uncertainty-aligned-block')
    p.text('(3)',rx+465,743,48,20,'serif',ink,label='caption')
    equation(p,r'\left(\frac{u_c(q)}{q}\right)^2=\left(\frac{u(k)}{k}\right)^2',rx+17,791,475,20,group='uncertainty-aligned-block')
    equation(p,r'\quad+\frac{u^2(T_1)+u^2(T_2)}{(T_1-T_2)^2}+\left(\frac{u(\Delta x)}{\Delta x}\right)^2',rx+17,861,475,20,group='uncertainty-aligned-block')
    # Cross-sectional technical illustration with genuinely different layout role.
    p.rectangle([rx+40,1000,rx+465,1147],'#e4edf0',outline=blue,width=2)
    p.line([rx+60,1071,rx+442,1071],'#7c939f',2)
    for xx,name in [(rx+128,'T1'),(rx+333,'T2')]:
        p.ellipse([xx-8,1063,xx+8,1079],blue)
        p.line([xx,1060,xx,970],blue,2);p.text(name,xx-16,940,75,19,'sans-bold',blue,label=None)
    p.line([rx+128,1172,rx+333,1172],blue,2)
    equation(p,r'\Delta x',rx+206,1184,85,14,display=False,component=True)
    p.region('illustration',[rx+34,939,rx+472,1225],None,kind='authored-paired-sensor-cross-section',not_a_photo=True)
    p.text('Figure 1. Sensor locations across the plate thickness; diagram not to scale.',rx,1243,w,18,'serif',ink,label='caption')
    p.text('Table 1. Illustrative input values',75,1321,1090,22,'serif-bold',ink,label='caption')
    p.table([75,1366,1165,1510],['INPUT','VALUE','STANDARD UNCERTAINTY','UNIT'],
            [['Conductivity','16.0','0.4','W / (m K)'],['Temperature difference','8.0','0.14','K'],['Sensor separation','2.00','0.02','mm']],
            widths=[.28,.17,.35,.20],row_height=34,border=False,size=18,header_fill='#e1e9ed',ink=ink)
    p.line([75,1531,1165,1531],blue,1)
    p.text('2. The independence assumption is a model choice; a shared calibration offset may cancel in the difference.',75,1545,1090,16,'serif',ink,label='footnote')
    p.text('[1] D. J. DeTurris, NASA TM–110196 (1995), pp. 1–2. Background on coupled wall measurements.',75,1584,1090,17,'serif',ink,role='bibliographic-reference')
    p.text('METHOD LIMIT  The estimate excludes contact resistance and temperature dependence of conductivity.',75,1631,1090,17,'sans-bold',blue,label='paragraph',role='aside')
    p.text('ANALYSIS NOTE 04  /  ORIGINAL SYNTHETIC TEACHING EXAMPLE',75,1694,1010,15,'mono',blue,label='footer')
    p.text('3',1130,1687,40,24,'serif',blue,label='footer')
    return p


def build():
    return [oscillation_lesson(),heat_flux_note()]
