"""Six ordinary born-digital prose pages; all wording and identities authored here."""
from corpus_v2.page import Page

INK='#171717'

def base(id,section,page=1,document=None):
 p=Page(id,1100,1556,paper='#ffffff',document_id=document,page_number=page)
 p.source['provenance']['rights']={'native_content':'Original authored text, fictional identities and original document layout. No third-party imagery or copied prose.','dataset_licensing':'Eligible for coordinator-chosen dataset license; installed fonts are referenced and hashed, never bundled.'}
 p.source['provenance']['purpose']='Separate common born-digital business/prose set; not an extension of the hard-layout V2 pilot set.'
 p.source['provenance']['source_style_family']={'common-letter-service-arrangement':'formal-service-letter','common-minutes-library-working-group':'working-group-minutes','common-report-community-shuttle-review':'single-column-service-report','common-email-training-room-confirmation':'printed-mail-message'}.get(id,'two-page-staff-policy-handbook')
 p.text(section,95,62,910,16,'sans',INK,label='header')
 p.line([95,99,1005,99],'#b7b7b7',1)
 p.text(f'{section}  |  {page}',95,1493,910,15,'sans','#656565',label='footer')
 return p

def para(p,s,y,size=22,face='serif',width=910,x=95,gap=19):
 return p.text(s,x,y,width,size,face,INK,leading=29)+gap

def heading(p,s,y):
 return p.text(s,95,y,910,25,'sans-bold',INK,label='title',leading=31)+16


def business_letter():
 p=base('common-letter-service-arrangement','HARTLEY PROPERTY SERVICES')
 p.text('Hartley Property Services\n18 Bell Street, Westhaven WH4 2LT\nOffice: 555-0142  |  office@hartley.example',95,135,910,19,'sans',INK,leading=27,label='paragraph')
 p.text('12 October 2026',95,252,910,21,'serif',INK,label='paragraph')
 p.text('Ms Nadia Ellis\nFacilities Coordinator\nWesthaven Community Centre\n7 Church Lane, Westhaven WH4 3AB',95,311,910,21,'serif',INK,leading=28,label='paragraph')
 p.text('Re: Winter maintenance arrangements',95,466,910,25,'sans-bold',INK,label='title')
 y=para(p,'Dear Ms Ellis,',525)
 y=para(p,'Thank you for meeting with us last Thursday to discuss the community centre’s winter maintenance needs. This letter confirms the arrangements we agreed and identifies the information we need before the first visit.',y)
 y=para(p,'Our team will attend on the first Monday of each month, beginning on 2 November. Each visit will include a visual check of external doors, a review of the plant-room log and minor repairs reported by your staff. We will send a short written record within two working days.',y)
 y=para(p,'The monthly fee is £285, excluding materials and any specialist work. We will ask for written approval before ordering parts that cost more than £75 or carrying out work beyond the agreed visit. Emergency call-outs remain subject to a separate quotation.',y)
 y=para(p,'Please provide the name and telephone number of the person who will let us into the building. We also need an updated list of areas that are unavailable during classes, so that the team can work around the centre’s programme without interrupting activities.',y)
 y=para(p,'If these arrangements reflect your understanding, please reply by 23 October. We can then issue the service schedule and confirm the first appointment. I look forward to working with you and your colleagues.',y)
 y=para(p,'Yours sincerely,',y+12)
 p.text('Daniel Mercer\nOperations Manager',95,y+24,910,22,'serif',INK,leading=29,label='paragraph')
 return p


def meeting_minutes():
 p=base('common-minutes-library-working-group','WESTHAVEN LIBRARY / WORKING GROUP')
 p.text('Reading room improvement group',95,139,910,37,'sans-bold',INK,label='title')
 p.text('Minutes of meeting held 8 October 2026, 10:00–11:15\nLocation: meeting room 2  |  Chair: Priya Shah  |  Notes: Owen Reed',95,206,910,20,'sans',INK,leading=28,label='paragraph')
 y=heading(p,'Present and apologies',302)
 y=para(p,'Present: Priya Shah, Owen Reed, Lucy Grant, Ben Okafor and Helen Moss. Apologies: Miriam Cole. The group approved the minutes of 10 September without amendment.',y)
 y=heading(p,'1. Feedback from readers',y+4)
 y=para(p,'Owen summarised the 43 comment cards received during September. Readers welcomed the quieter seating area but reported that the desk lamps were difficult to adjust. Several people asked for a larger-print version of the room guide. The group agreed that the guide should be revised before additional copies are ordered.',y)
 y=heading(p,'2. Furniture and access',y+4)
 y=para(p,'Lucy presented two quotations for replacement chairs. Members preferred the model with arms because it offers better support when sitting down or standing up. Before placing an order, Lucy will arrange a one-week trial of two chairs and check that the aisle remains clear when they are in use.',y)
 y=heading(p,'3. Agreed actions',y+4)
 p.table([95,y,1005,y+225],['Action','Owner','Due'],[['Revise the room guide in large print','Owen','19 October'],['Arrange a trial of two chairs','Lucy','22 October'],['Check lamp adjustment instructions','Ben','29 October'],['Report trial feedback to the group','Helen','5 November']],widths=[.64,.17,.19],row_height=40,size=18,header_fill='#eeeeee',ink=INK)
 y+=230
 y=heading(p,'4. Budget and next meeting',y)
 y=para(p,'No expenditure was authorised at this meeting. The chair will confirm the remaining budget after the chair trial. The next meeting will take place on Thursday 5 November at 10:00 in meeting room 2.',y)
 p.text('Minutes circulated 12 October 2026. Corrections should be sent to the chair before the next meeting.',95,y+5,910,17,'sans','#555555',leading=23,label='caption')
 return p


def handbook():
 doc='westhaven-flexible-working-policy';out=[]
 p=base('common-handbook-flexible-working-01','STAFF HANDBOOK / PEOPLE AND WORK',1,doc)
 p.text('Flexible working',95,143,910,43,'sans-bold',INK,label='title')
 p.text('Policy 04  |  Version 1.2  |  Effective 1 November 2026\nPolicy owner: People Services  |  Review due: November 2027',95,215,910,18,'sans',INK,leading=26,label='paragraph')
 y=heading(p,'1. Purpose and scope',310)
 y=para(p,'This policy explains how staff at Westhaven Advice Partnership can request a regular change to their working pattern. It applies to all employees. It covers changes to working hours, the days worked and the location from which work is normally carried out.',y)
 y=para(p,'The partnership aims to make workable arrangements that support staff and maintain a reliable service. A request will be considered on its own circumstances, including the needs of the role, the team and the people who use the service.',y)
 y=heading(p,'2. Types of arrangement',y+5)
 y=para(p,'Common arrangements include adjusted start and finish times, part-time hours, compressed hours and a regular combination of home and office working. A temporary arrangement may be appropriate where a staff member’s circumstances are expected to change.',y)
 y=para(p,'An occasional change agreed with a manager does not automatically become a permanent working pattern. Managers and staff should record whether an arrangement is temporary, a trial or a lasting change to the employment agreement.',y)
 y=heading(p,'3. Before making a request',y+5)
 y=para(p,'Staff are encouraged to speak with their manager before submitting a request. The conversation should explore how the proposed pattern would work in practice and identify any questions that need to be resolved. A conversation is helpful but does not replace a written request.',y)
 y=para(p,'Consider the following points before applying:',y,21,'sans',gap=3)
 y=p.text('• The hours, days or location you would like to change.\n• When you would like the arrangement to begin.\n• How colleagues and service users could contact you.\n• Any effect on shared tasks, meetings or reception cover.',95,y,910,21,'sans',INK,leading=29,label='list')+19
 p.text('The request and review process continues on page 2.',95,1435,910,18,'serif-italic','#555555',label='caption')
 out.append(p)
 p=base('common-handbook-flexible-working-02','STAFF HANDBOOK / PEOPLE AND WORK',2,doc)
 p.text('Flexible working — continued',95,143,910,34,'sans-bold',INK,label='title')
 y=heading(p,'4. Submit a written request',221)
 y=para(p,'Send your request to your manager and copy People Services. State the proposed arrangement, the preferred start date and whether you are asking for a permanent change or a trial. If the request is connected with an access need, you may discuss that separately with People Services.',y)
 y=heading(p,'5. Discussion and decision',y+5)
 y=para(p,'Your manager will acknowledge the request within five working days and arrange a meeting to discuss it. You may bring a colleague to the meeting. The discussion should test practical options and consider alternatives if the original proposal cannot be supported.',y)
 y=para(p,'The manager will provide a written decision that explains the arrangement approved, any trial period and the review date. If the request is declined, the decision will explain the operational reasons and describe how to ask for a review.',y)
 y=heading(p,'6. Recording an agreed arrangement',y+5)
 y=para(p,'People Services will confirm any change to contractual hours or normal working location. The written record should cover the start date, hours of availability, meeting expectations and any equipment provided. Staff should check the record and raise errors before the arrangement begins.',y)
 y=heading(p,'7. Trial periods and review',y+5)
 y=para(p,'A trial will normally last eight weeks. The manager and staff member should agree simple measures before it starts, such as reliable cover, completion of shared tasks and response times. They should meet near the middle of the trial and again before it ends.',y)
 y=para(p,'At the final review, the arrangement may be confirmed, adjusted or ended. Any changes must be recorded in writing. An agreed arrangement can also be reviewed later if the role or service changes substantially.',y)
 y=heading(p,'8. Questions and confidential advice',y+5)
 y=para(p,'Speak to People Services if you need help preparing a request or understanding a decision. Personal information will be shared only with colleagues who need it to consider or administer the arrangement.',y)
 p.text('Internal policy for a fictional organisation. This is an authored document sample, not legal guidance.',95,1428,910,16,'sans','#666666',leading=22,label='caption')
 out.append(p);return out


def report():
 p=base('common-report-community-shuttle-review','WESTHAVEN COMMUNITY TRANSPORT')
 p.text('Community shuttle: September review',95,141,910,36,'sans-bold',INK,label='title')
 p.text('Prepared by Alex Morgan, service coordinator  |  9 October 2026',95,208,910,18,'sans','#555555',label='paragraph')
 y=heading(p,'Summary',270)
 y=para(p,'The community shuttle completed all scheduled September journeys. Passenger numbers increased after the afternoon departure was moved fifteen minutes later. The change helped people leaving the health centre, although drivers reported a longer queue at the market stop on Fridays.',y)
 y=heading(p,'Service use',y+5)
 y=para(p,'The service recorded 684 passenger journeys, compared with 612 in August. These totals count each boarding rather than individual passengers. The busiest week was the week beginning 14 September, when two local events increased travel to the town centre.',y)
 p.table([95,y,1005,y+205],['Week beginning','Passenger journeys','Completed services'],[['31 August','151','20 of 20'],['7 September','162','20 of 20'],['14 September','194','20 of 20'],['21 September','177','20 of 20']],widths=[.37,.36,.27],row_height=38,size=19,header_fill='#eeeeee',ink=INK)
 y+=215
 y=heading(p,'Operational observations',y)
 y=para(p,'Drivers reported no vehicle faults that interrupted a journey. A loose handrail fitting was identified during a morning check and tightened before departure. Two passengers asked for clearer information about the last return service; the printed timetable at the market stop had faded.',y)
 y=heading(p,'Recommended next steps',y+5)
 y=para(p,'Replace the timetable at the market stop and add the last return time to the booking reminder. Keep the later afternoon departure through November, then compare passenger feedback with the September record. The coordinator should review Friday boarding times with drivers before considering any further timetable change.',y)
 p.text('Source: driver journey sheets and the booking register. Figures are fictional and authored for this document.',95,1419,910,16,'sans','#666666',leading=22,label='caption')
 return p


def printed_email():
 p=base('common-email-training-room-confirmation','MAIL / PRINTED MESSAGE')
 p.text('Training room booking — final details',95,144,910,32,'sans-bold',INK,label='title')
 y=176
 for label,value in [('From:','Ruth Parker <ruth.parker@harbour.example>'),('To:','Sam Walker <sam.walker@learning.example>'),('Cc:','Reception <welcome@harbour.example>'),('Sent:','Monday, 12 October 2026 at 09:42'),('Subject:','Training room booking — final details')]:
  y+=43;p.text(label,95,y,115,18,'sans-bold',INK,label='paragraph');p.text(value,220,y,785,18,'sans',INK,label='paragraph')
 p.line([95,465,1005,465],'#c2c2c2',1)
 y=para(p,'Hi Sam,',502,21,'sans')
 y=para(p,'Thanks for sending the final attendee numbers. I have confirmed room 3 for your workshop on Wednesday 21 October, from 09:00 to 13:00. The room will be available from 08:30 so that you can set up before people arrive.',y,21,'sans')
 y=para(p,'We will arrange the tables in four groups of six and leave a clear route from the entrance to the presentation screen. A projector, an HDMI lead and a flip chart are included. Please bring your laptop and any adapter it needs.',y,21,'sans')
 y=para(p,'Reception will direct attendees upstairs. If anyone needs the lift, ask them to use the main entrance and speak to the welcome desk. Tea and coffee will be outside the room at 10:30; the catering team has noted the two dairy-free requests.',y,21,'sans')
 y=para(p,'A few final points:',y,21,'sans',gap=3)
 y=p.text('• Send the joining instructions by Friday.\n• Let us know if the number of attendees changes.\n• Remove posters and personal items when you leave.\n• Return the room key to reception after the session.',95,y,910,21,'sans',INK,leading=29,label='list')+19
 y=para(p,'The invoice will be sent to your finance address after the event. If you need a purchase order number shown on it, please send that before the workshop.',y,21,'sans')
 y=para(p,'Best wishes,\nRuth',y+4,21,'sans')
 p.text('Ruth Parker\nVenue Coordinator | Harbour Learning\n555-0126 | ruth.parker@harbour.example',95,y+5,910,18,'sans','#555555',leading=25,label='paragraph')
 return p


def build():
 return [business_letter(),meeting_minutes(),*handbook(),report(),printed_email()]
