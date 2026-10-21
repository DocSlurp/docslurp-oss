"""Six original, ordinary office documents, with distinct source arrangements.

Fictional organizations, addresses, accounts and data. No external text/assets.
Shared text/table utilities are construction code, not transformed page templates.
"""
from decimal import Decimal
from pathlib import Path
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from corpus_v2.page import Page,poly

BLACK='#151515'
GRAY='#666666'


def office(identifier,genre,width=1200,height=1600):
    p=Page(identifier,width,height,paper='#ffffff')
    p.source['provenance'].update(kind='original-authored-common-office-document',fictional=True,rights={'status':'original-authored-text-data-and-layout','source':'Written specifically for common input corpus; no copied third-party prose, logos, account data or images','font_policy':'Installed font files referenced and hashed, never redistributed'})
    p.source['common_corpus']={'genre':genre,'source_family':identifier,'style_family':genre,'template_group':identifier,'construction_helpers':'Shared Page primitives and local table/text helpers; no repeated source template or parameterized page-count expansion'}
    p.source['limitations']=['Fictional original ordinary office document; authored source-derived annotation pending independent review.','No real account, customer or shipment is represented.']
    return p


def text(p,value,x,y,w,size=21,bold=False,label='paragraph'):
    return p.text(value,x,y,w,size,'sans-bold' if bold else 'sans',BLACK,label=label,leading=size*1.3)


def footer(p,value):
    p.line([72,p.height-100,p.width-72,p.height-100],'#b7b7b7')
    text(p,value,72,p.height-79,p.width-144,16,label='footer')


def table(p,x,y,width,headers,rows,widths,row_height=48,size=20,rules=True,header_fill='#eeeeee'):
    cells=[];allrows=[headers]+rows
    for ri,row in enumerate(allrows):
        xx=x;yy=y+ri*row_height
        if ri==0 and header_fill:p.rectangle([x,yy,x+width,yy+row_height],header_fill)
        for ci,value in enumerate(row):
            cb=[xx,yy,xx+width*widths[ci],yy+row_height]
            before=len(p.source['text_blocks']);text(p,str(value),xx+9,yy+12,cb[2]-xx-18,size,bold=ri==0,label=None)
            for block in p.source['text_blocks'][before:]:
                b=block['bbox']
                if b[0]<cb[0] or b[2]>cb[2] or b[1]<cb[1] or b[3]>cb[3]:raise ValueError(f'Cell overflow {value}: {b} outside {cb}')
            cells.append({'row':ri,'column':ci,'text':str(value),'bbox':cb,'polygon':poly(cb),'is_header':ri==0,'visibility':1.0,'truncated':False});xx=cb[2]
        if rules:p.line([x,yy+row_height,x+width,yy+row_height],'#c8c8c8')
    return p.region('table',[x,y,x+width,y+len(allrows)*row_height],None,cells=cells,columns=len(headers),rows=len(allrows),border=False,table_kind='ordinary-office-aligned-cells')


def invoice():
    p=office('common-larch-studio-invoice','service-invoice')
    text(p,'LARCH STUDIO',75,75,700,35,True,label='header')
    text(p,'Design and document services\n34 Willow Lane\nFairhaven, OR 97000',76,132,580,21)
    text(p,'INVOICE',820,78,305,42,True,label='title')
    text(p,'Invoice: LS-2026-041\nIssued: 12 October 2026\nDue: 11 November 2026',820,153,305,20)
    p.line([75,260,1125,260],BLACK,2)
    text(p,'BILL TO',75,300,500,18,True,label='title')
    text(p,'Ridgeway Community Centre\nAccounts payable\n18 East Street\nFairhaven, OR 97000',75,342,570,23)
    text(p,'PROJECT',750,300,375,18,True,label='title')
    text(p,'Autumn programme booklet\nReference: RC-119\nPayment terms: Net 30',750,342,375,22)
    rows=[['Page layout and typesetting','12','45.00','540.00'],['Proof corrections','2','45.00','90.00'],['Accessible PDF preparation','1','85.00','85.00'],['Print-ready file delivery','1','25.00','25.00']]
    table(p,75,570,1050,['Description','Hours / qty','Rate','Amount'],rows,[.49,.17,.17,.17],64,21)
    subtotal=sum(Decimal(r[3]) for r in rows)
    assert subtotal==Decimal('740.00')
    text(p,'Subtotal\nSales tax\nTOTAL DUE',755,970,200,24,True)
    text(p,'$740.00\n$0.00\n$740.00',985,970,150,24,True)
    p.line([750,1086,1125,1086],BLACK,2)
    text(p,'Payment instructions',75,1135,700,23,True,label='title')
    text(p,'Please quote LS-2026-041 with your payment. Send remittance advice to accounts@larch-studio.example. Contact us before the due date if a line item needs clarification.',75,1182,1030,22)
    text(p,'Thank you for working with us.',75,1340,900,22)
    footer(p,'Larch Studio  |  accounts@larch-studio.example  |  Page 1 of 1')
    return p


def purchase_order():
    p=office('common-cedar-office-purchase-order','purchase-order')
    text(p,'CEDAR OFFICE COOPERATIVE',72,64,1040,29,True,label='header')
    text(p,'PURCHASE ORDER',72,119,850,40,True,label='title')
    text(p,'PO number: CO-1842     Order date: 14 October 2026',72,184,1040,23)
    p.line([72,239,1128,239],BLACK,2)
    text(p,'SUPPLIER',72,275,490,18,True,label='title')
    text(p,'Beacon Workplace Supplies\nOrder desk\n27 Foundry Road\nMillford, WA 98000',72,314,500,22)
    text(p,'DELIVER TO',650,275,478,18,True,label='title')
    text(p,'Cedar Office Cooperative\nReceiving desk, ground floor\n8 Cedar Court\nMillford, WA 98000',650,314,478,22)
    text(p,'Requested delivery: 23 October 2026\nDelivery window: Monday to Friday, 9 am–4 pm\nContact: Avery Cole, office@cedar-coop.example',72,470,1056,21)
    rows=[['P-80','Copy paper, A4, 80 gsm','10','6.40','64.00'],['FL-12','Document folders, pack of 12','3','9.50','28.50'],['PN-10','Black ballpoint pens, pack of 10','4','5.25','21.00'],['LB-24','Address labels, 24 sheets','2','11.75','23.50']]
    table(p,72,630,1056,['Code','Item description','Qty','Unit price','Line total'],rows,[.12,.43,.1,.17,.18],67,19)
    assert sum(Decimal(r[-1]) for r in rows)==Decimal('137.00')
    text(p,'Goods total: $137.00\nDelivery: $0.00\nORDER TOTAL: $137.00',730,1020,398,24,True)
    text(p,'Order conditions',72,1030,580,23,True,label='title')
    text(p,'Do not substitute items without written approval. Include the PO number on the packing list and invoice. Report shortages to the order contact before dispatch.',72,1075,560,21)
    p.rectangle([72,1240,1128,1400],None,outline='#888888')
    text(p,'APPROVAL',94,1256,950,18,True,label='title')
    text(p,'Requested by: Avery Cole\nApproved by: Morgan Bell\nApproval date: 14 October 2026',94,1294,955,22)
    footer(p,'PO CO-1842  |  This order is valid only for the goods and quantities listed above.')
    return p


def bank_statement():
    p=office('common-harbour-credit-activity','account-activity-statement')
    text(p,'HARBOUR CREDIT',75,66,900,32,True,label='header')
    text(p,'Account activity statement',75,128,1050,37,True,label='title')
    text(p,'STATEMENT PERIOD  1–30 September 2026',75,191,1050,20,True)
    text(p,'Rowan Ellis\n47 Orchard Close\nEastbrook, ME 04000',75,274,600,23)
    text(p,'Account: Everyday account\nAccount number: •••• 4821\nCurrency: USD',750,274,375,22)
    p.line([75,400,1125,400],BLACK,2)
    table(p,75,442,1050,['Opening balance','Money in','Money out','Closing balance'],[['$1,245.80','$2,400.00','$1,154.47','$2,491.33']],[.25,.25,.25,.25],64,21)
    text(p,'TRANSACTIONS',75,642,1050,22,True,label='title')
    data=[('02 Sep','Salary credit','2400.00',None),('04 Sep','Rent payment',None,'850.00'),('07 Sep','Meadow Market',None,'62.35'),('11 Sep','City transit pass',None,'48.00'),('15 Sep','Utility payment',None,'91.72'),('21 Sep','Bookshop purchase',None,'27.40'),('27 Sep','Household supplies',None,'75.00')]
    balance=Decimal('1245.80');rows=[]
    for date,description,credit,debit in data:
        balance+=Decimal(credit or '0')-Decimal(debit or '0');rows.append([date,description,debit or '—',credit or '—',f'{balance:,.2f}'])
    assert balance==Decimal('2491.33')
    table(p,75,698,1050,['Date','Description','Money out','Money in','Balance'],rows,[.12,.36,.17,.17,.18],57,19)
    text(p,'Please check your statement',75,1240,1050,24,True,label='title')
    text(p,'Review the entries and tell us if you do not recognise a transaction. Keep this statement with your records. This fictional account is provided only as an example document.',75,1290,1050,22)
    footer(p,'Harbour Credit  |  Fictional example statement  |  Page 1 of 1')
    return p


def application():
    p=office('common-westfield-library-application','blank-membership-application')
    text(p,'WESTFIELD PUBLIC LIBRARY',75,67,1050,29,True,label='header')
    text(p,'Library membership application',75,128,1050,36,True,label='title')
    text(p,'Please print clearly. Leave the staff section blank. Bring proof of your current address when you submit this form.',75,199,1050,22)
    fields=[]
    def field(label,x,y,width,height=69):
        text(p,label,x+12,y+10,width-24,19,True,label=None);p.rectangle([x,y,x+width,y+height],None,outline='#777777')
        fields.append({'label':label,'value':'','value_presence':'explicitly-blank','prose_applicability':'label-present; user response absent','bbox':[x,y,x+width,y+height]})
    field('Family name',75,310,510);field('Given names',605,310,520)
    field('Date of birth (DD / MM / YYYY)',75,405,370);field('Preferred name (optional)',465,405,660)
    field('Street address',75,500,1050)
    field('Town / city',75,595,650);field('Postal code',745,595,380)
    field('Email address',75,690,650);field('Telephone',745,690,380)
    text(p,'CONTACT PREFERENCE',87,804,1000,19,True,label=None)
    for xx,label in [(90,'Email'),(350,'Telephone'),(650,'Post')]:
        p.rectangle([xx,853,xx+22,875],None,outline=BLACK);text(p,label,xx+36,850,250,20,label=None);fields.append({'label':label,'value':False,'value_presence':'explicitly-unchecked','field_type':'checkbox','bbox':[xx,853,xx+22,875]})
    text(p,'DECLARATION',87,938,1000,20,True,label=None)
    text(p,'I agree to follow the library borrowing rules and to notify the library if my contact details change. I understand that I am responsible for items borrowed using my card.',87,982,1005,22,label=None)
    field('Signature',87,1095,650,86);field('Date',757,1095,356,86)
    p.region('form',[75,310,1125,1181],None,fields=fields,form_state='blank-uncompleted',blank_field_policy='All response values explicitly absent or unchecked; labels are authored prose, no inferred responses')
    p.rectangle([75,1260,1125,1390],'#f0f0f0',outline='#999999')
    text(p,'STAFF USE ONLY',92,1275,1000,18,True,label=None)
    text(p,'Card number: ____________________    Address checked: ________\nStaff initials: __________    Date issued: ____________________',92,1317,1000,20,label=None)
    p.region('form',[75,1260,1125,1390],None,fields=[{'label':'Card number','value':'','value_presence':'explicitly-blank'},{'label':'Address checked','value':'','value_presence':'explicitly-blank'},{'label':'Staff initials','value':'','value_presence':'explicitly-blank'},{'label':'Date issued','value':'','value_presence':'explicitly-blank'}],form_state='blank-staff-section')
    footer(p,'Return the completed form to the library desk.  |  Application form WM-01  |  Page 1 of 1')
    return p


def packing_list():
    p=office('common-northline-packing-list','warehouse-packing-list')
    text(p,'NORTHLINE PARTS',75,70,650,34,True,label='header')
    text(p,'PACKING LIST',750,73,375,36,True,label='title')
    text(p,'Dispatch NP-6038\nOrder SO-2207\nDispatch date: 19 October 2026',750,140,375,22)
    text(p,'From: Northline Parts\nUnit 6, Rail Yard Road\nBridgeport, VT 05000',75,143,580,22)
    p.line([75,278,1125,278],BLACK,2)
    text(p,'SHIP TO',75,316,900,18,True,label='title')
    text(p,'Oak Street Repair Workshop\nAttention: Receiving\n22 Oak Street\nBridgeport, VT 05000',75,356,670,24)
    text(p,'Carrier: County Parcel\nService: Standard ground\nPackages: 2 cartons\nTotal gross weight: 8.6 kg',750,356,375,21)
    rows=[['BR-08','Mounting bracket, zinc','8','8','0'],['SC-20','M6 screw kit, 20 pieces','4','4','0'],['PD-04','Rubber isolation pad','12','12','0'],['CL-15','Cable clip, 15 mm','30','24','6'],['WS-10','Washer set, 10 pieces','3','3','0']]
    table(p,75,606,1050,['Item code','Description','Ordered','Packed','Backorder'],rows,[.15,.40,.15,.15,.15],66,19)
    text(p,'Packing details',75,1090,1050,24,True,label='title')
    text(p,'Carton 1: mounting brackets, screw kits and washer sets.\nCarton 2: isolation pads and cable clips.\nSix CL-15 cable clips remain on backorder and will ship separately.',75,1139,1050,22)
    text(p,'Packed by: J. Ward     Checked by: L. Finch',75,1280,1050,22)
    text(p,'Received by: __________________________    Date: __________________',75,1360,1050,22)
    footer(p,'No prices shown. This packing list is not an invoice.  |  NP-6038  |  Page 1 of 1')
    return p


def stock_report():
    p=office('common-morrow-monthly-stock-report','borderless-spreadsheet-report',1550,1100)
    text(p,'MORROW COMMUNITY SUPPLIES',65,45,1400,24,True,label='header')
    text(p,'Monthly stock movement',65,96,1400,34,True,label='title')
    text(p,'September 2026  |  Store room A  |  Prepared by: N. Shah  |  Units, not currency',65,155,1400,20)
    rows=[['A101','A4 copy paper, ream','42','60','71','31','20'],['A102','A3 copy paper, ream','18','20','23','15','10'],['B110','Black marker, each','67','50','78','39','25'],['B120','Blue marker, each','35','40','42','33','20'],['C210','Masking tape, roll','24','30','36','18','15'],['C220','Clear tape, roll','31','20','29','22','15'],['D310','Glue stick, each','52','40','61','31','20'],['D320','Scissors, pair','16','10','8','18','8'],['E410','Envelopes, pack','21','15','24','12','10'],['E420','Document wallet, each','80','50','94','36','25']]
    for r in rows:assert int(r[2])+int(r[3])-int(r[4])==int(r[5])
    table(p,65,240,1420,['Code','Stock item','Opening','Received','Issued','Closing','Min. level'],rows,[.09,.31,.12,.12,.12,.12,.12],48,20,rules=False,header_fill=None)
    p.line([65,235,1485,235],BLACK,2);p.line([65,286,1485,286],'#777777');p.line([65,776,1485,776],BLACK)
    text(p,'CHECK: Opening + received − issued = closing. All ten item rows reconcile.',65,820,1420,21,True)
    text(p,'Summary',65,883,1420,23,True,label='title')
    text(p,'Document wallets recorded the highest issue count (94). All ten stock lines remained above their minimum levels. Review October demand before placing the next replenishment order.',65,926,1420,22)
    footer(p,'Morrow Community Supplies  |  Internal stock report  |  Printed 2 October 2026  |  Page 1 of 1')
    return p


def build():
    return [invoice(),purchase_order(),bank_statement(),application(),packing_list(),stock_report()]
