"""Original simulated rainfall and waveform logs for publication review.

These are fictional stations and analytic signals, not weather observations,
earthquake records, hazard notices, or calibration certificates. No detector runs.
"""
import math
try:
    from .page import Page,poly
except ImportError:
    from page import Page,poly


def rainfall_log():
    p=Page('instruments-rainfall-field-log',1200,1800,paper='#fffdf6')
    navy='#164b60';teal='#207c80';ink='#263c45'
    intervals=[0.0,0.4,1.2,2.8,4.6,3.4,1.8,0.8,0.2,0.0,0.6,1.4,2.0,1.0,0.4,0.0]
    times=[f'{8+i//4:02d}:{(i%4)*15:02d}' for i in range(16)]
    end_times=[f'{8+(i+1)//4:02d}:{((i+1)%4)*15:02d}' for i in range(16)]
    totals=[];running=0
    for value in intervals:running=round(running+value,1);totals.append(running)
    p.source['data_provenance']={'kind':'original-authored-simulated-readings','fictional_station':'Alder Beck learning station','not_observed_weather':True,
        'interval_start_times_local':times,'interval_end_times_local':end_times,'interval_minutes':15,'rainfall_mm':intervals,'cumulative_mm':totals,
        'measurement_model':'0.2mm per simulated tipping-bucket increment','expected_total_mm':20.6}
    assert totals[-1]==20.6
    p.source['planned_capture']={'kind':'partial-flatbed-scan','crop_box':[0,0,1200,1458],
        'purpose':'Bottom edge intersects observation table and text. Keep original full source/expected Markdown; visible-only text contract must distinguish clipped and excluded cells.',
        'review_status':'not_admitted-awaiting-capture-and-visual-review'}
    p.rectangle([0,0,1200,27],navy)
    p.text('ALDER BECK  /  FIELD METHODS',67,63,1070,19,'sans-bold',navy,label='header')
    p.text('When the rain arrived',65,108,1070,65,'serif-bold',ink,label='title')
    p.text('A 15-minute observation log',68,196,1060,28,'serif-italic',teal)
    p.rectangle([68,267,1132,364],'#e7f0eb')
    p.text('SIMULATED READINGS',88,283,1000,20,'sans-bold',navy,label='title')
    p.text('Fictional station AB–04 · 18 October 2026 · local clock UTC+00:00\nTipping-bucket resolution 0.2 mm · accumulation reset at 08:00',88,320,1000,19,'mono',ink,leading=27)
    p.text('The first pulse is short and intense; a later shower adds a smaller amount. The cumulative curve can only rise or remain level. A flat interval records no simulated bucket tips, rather than a missing reading.',68,410,1062,25,'serif',ink,leading=32)
    # Original two-panel graph: interval bars and cumulative line use different axes.
    x0,x1=153,1090;top,bottom=577,764
    p.text('RAINFALL PER INTERVAL',69,536,1045,20,'narrow-bold',navy,label='title')
    for tick in (0,1,2,3,4,5):
        y=bottom-tick/5*(bottom-top);p.line([x0,y,x1,y],'#ced8d5',1)
        p.text(str(tick),108,y-11,35,17,'mono',navy,label=None)
    for i,value in enumerate(intervals):
        x=x0+i*(x1-x0)/16;p.rectangle([x+8,bottom-value/5*(bottom-top),x+43,bottom],teal)
        if i%4==0:p.text(times[i],x+1,784,105,18,'mono',navy,label=None)
    p.text('mm',75,586,35,16,'sans',navy,label=None)
    p.region('chart',[60,562,1130,819],None,chart_kind='authored-simulated-interval-rainfall',data=intervals,axis_labels=['interval start time','rainfall mm'],times=times)
    p.text('CUMULATIVE TOTAL',69,841,1045,20,'narrow-bold',navy,label='title')
    points=[]
    for i,value in enumerate(totals):points.extend([x0+i*(x1-x0)/15,944-value/22*63])
    p.line([x0,944,x1,944],'#a2b7b4',1);p.line(points,navy,3)
    p.text('0',113,933,35,16,'mono',navy,label=None);p.text('20.6 mm',969,862,150,19,'mono',navy,label=None)
    p.region('chart',[95,858,1130,963],None,chart_kind='authored-simulated-cumulative-rainfall',data=totals,axis_labels=['interval end','cumulative rainfall mm'],times=end_times)
    p.text('OBSERVATION REGISTER',68,1002,1070,24,'sans-bold',navy,label='title')
    p.text('All intervals are 15 minutes. Compare interval increments with the running total.',68,1043,1070,20,'serif-italic',ink,label='caption')
    x=[68,275,500,790,1132];y0=1096;rh=34
    headers=['START','RAIN / mm','TOTAL / mm','BUCKET TIPS'];rows=[headers]+[[t,f'{a:.1f}',f'{b:.1f}',str(round(a/.2))] for t,a,b in zip(times,intervals,totals)]
    cells=[]
    for ri,row in enumerate(rows):
        yy=y0+ri*rh
        for ci,text in enumerate(row):
            box=[x[ci],yy,x[ci+1],yy+rh]
            p.text(text,x[ci]+8,yy+7,x[ci+1]-x[ci]-16,19,'sans-bold' if ri==0 else 'mono',navy if ri==0 else ink,label=None)
            cells.append({'row':ri,'column':ci,'logical_row':ri,'text':text,'bbox':box,'polygon':poly(box),'is_header':ri==0,'visibility':1.0,'truncated':False})
    p.region('table',[68,y0,1132,y0+len(rows)*rh],None,cells=cells,rows=len(rows),columns=4,border=False,
        continuation_id='alder-beck-observation-register',full_source_row_count=16,table_kind='borderless-aligned-instrument-log',
        source_completeness='complete source; partial-scan derivative explicitly planned',units={'rain':'mm','total':'mm','bucket_tips':'count'},
        table_data={'headers':headers,'rows':rows[1:]})
    p.text('QUALITY NOTE  Zero is a valid reading. A missing interval would be marked NA and excluded from the cumulative total.',68,1710,1060,19,'sans',navy)
    p.text('SIMULATED FIELD LOG · ORIGINAL TEACHING DATA · AB–04',68,1764,1060,15,'mono',navy,label='footer')
    return p


def seismograph_log():
    p=Page('instruments-simulated-waveform-log',1600,1120,paper='#fdfcf9')
    ink='#263436';green='#245a55';red='#9f493c'
    p.text('INSTRUMENT ROOM  /  CHANNEL REVIEW',65,40,1460,18,'mono',green,label='header')
    p.text('Two minutes on the recorder',64,83,1460,54,'serif-bold',ink,label='title')
    p.text('SIMULATED SEISMOGRAPH SIGNAL  ·  Fictional station ST–12  ·  20 samples/s',67,163,1460,21,'sans-bold',red)
    p.text('21 OCT 2026   18:24:00–18:26:00 UTC     /     CHANNELS E–W AND N–S     /     COUNTS: ARBITRARY UNITS',67,211,1460,17,'mono',ink)
    p.source['data_provenance']={'kind':'original-analytic-simulated-waveforms','fictional_station':'ST-12','not_actual_seismic_record':True,
        'sample_rate_hz':20,'duration_seconds':120,'start_utc':'2026-10-21T18:24:00Z','no_hazard_inference':True,
        'model':'bounded sinusoidal background plus exponentially decaying analytic bursts; deterministic; not recorded sensor data'}
    waveforms=[]
    for ci in range(2):
        series=[]
        for i in range(2401):
            t=i/20;value=1.7*math.sin(2*math.pi*.8*t+ci)+.9*math.sin(2*math.pi*2.3*t)
            if t>=37: value+=(26 if ci==0 else 18)*math.exp(-(t-37)/13)*math.sin(2*math.pi*(3.1 if ci==0 else 2.6)*(t-37))
            if t>=81: value+=8*math.exp(-(t-81)/7)*math.sin(2*math.pi*1.7*(t-81))
            series.append(round(value,5))
        waveforms.append(series)
    p.source['data_provenance']['waveform_samples_by_channel']={'E-W':waveforms[0],'N-S':waveforms[1]}
    for ci,(channel,series) in enumerate(zip(('E–W','N–S'),waveforms)):
        top=286+ci*260;bottom=top+197;mid=(top+bottom)/2;left,right=164,1505
        p.rectangle([66,top,1535,bottom],'#f7faf6')
        for tick in range(13):
            xx=left+(right-left)*tick/12;p.line([xx,top,xx,bottom],'#d4ddd6',1)
            if ci==1:p.text(f'{tick*10:03d}',xx-13,bottom+10,56,15,'mono',green,label=None)
        for v in (-30,-15,0,15,30):
            yy=mid-v/30*80;p.line([left,yy,right,yy],'#d4ddd6',1)
            p.text(str(v),127,yy-8,34,14,'mono',green,label=None)
        coords=[]
        for i,value in enumerate(series):coords.extend([left+i/(len(series)-1)*(right-left),mid-value/30*80])
        p.line(coords,ink,1)
        p.text(channel,77,top+17,49,18,'sans-bold',green,label=None)
        for seconds,label in [(37,'A'),(81,'B')]:
            xx=left+seconds/120*(right-left);p.line([xx,top,xx,bottom],red,1)
            if ci==0:p.text(label,xx+6,top+5,40,18,'sans-bold',red,label=None)
        p.region('chart',[66,top,1535,bottom+(35 if ci else 0)],None,chart_kind='original-simulated-seismograph-time-series',channel=channel,
            sample_rate_hz=20,data=series,time_origin_utc='2026-10-21T18:24:00Z',amplitude_units='arbitrary recorder counts',
            event_markers=[{'id':'A','seconds_from_start':37},{'id':'B','seconds_from_start':81}],not_actual_seismic_record=True)
    p.text('ELAPSED SECONDS FROM 18:24:00 UTC',886,807,645,17,'mono',green,label='caption')
    p.line([68,859,1534,859],green,1)
    p.text('TIMESTAMP CHECK',68,890,430,22,'sans-bold',green,label='title')
    p.text('A  18:24:37 UTC\nB  18:25:21 UTC\nClock offset: 0.00 s (simulated)',68,938,470,20,'mono',ink,leading=29)
    p.text('RECORDER CALIBRATION',585,890,455,22,'sans-bold',green,label='title')
    p.line([610,1006,670,1006,670,951,748,951,748,1006,825,1006],green,3)
    p.text('20 counts',844,948,160,19,'mono',ink,label=None)
    p.text('1.0 second',636,1024,320,17,'mono',ink,label=None)
    p.region('illustration',[586,936,1005,1057],None,illustration_kind='authored-recorder-calibration-step',step_duration_seconds=1.0,step_height_counts=20,not_a_measured_calibration=True)
    p.text('READ THE SIGNAL',1100,890,430,22,'sans-bold',green,label='title')
    p.text('A marks the first synthetic burst; B marks a smaller later pulse. The trace does not identify a location, event magnitude or real hazard.',1100,937,430,20,'serif',ink,leading=25)
    p.text('ORIGINAL SIMULATION FOR DOCUMENT-LAYOUT REVIEW  /  NOT AN OBSERVATIONAL OR HAZARD PRODUCT',68,1085,1460,15,'mono',green,label='footer')
    return p


def build():
    return [rainfall_log(),seismograph_log()]
