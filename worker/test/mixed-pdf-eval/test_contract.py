import copy,unittest
from contract import identity_hash,validate_manifest,validate_policy_receipt,validate_labels,validate_complete_inventory,validate_panel_binding,page_content_hash

class ContractTests(unittest.TestCase):
    def manifest(self):
        return {'schema':'mixed-pdf-authored@v2','families':1,'pageCount':60,'cases':[
            {'id':f'authored-case-{i}','family':'source-a','split':'train','pages':[{}]*10,'hardPercent':i,
             'sourceContentHash':'d'*64,'pageIds':[str(n) for n in range(10)],'pageReferenceHashes':['e'*64]*10,'pageContentHashes':[identity_hash(str(n)) for n in range(10)],'sha256':'a'*64,'labelHash':'b'*64,'sourceLayoutHash':'c'*64,'pdf':f'inputs/{i}.pdf','labels':f'labels/{i}.json'} for i in range(0,101,20)]}
    def test_complete_family(self): self.assertEqual(len(validate_manifest(self.manifest())),6)
    def test_missing_variants_duplicates_and_cross_split(self):
        for mutation in ['missing','duplicate','split']:
            value=self.manifest()
            if mutation=='missing':value['cases'].pop()
            elif mutation=='duplicate':value['cases'][1]['id']=value['cases'][0]['id']
            else:value['cases'][1]['split']='heldout'
            with self.assertRaises(RuntimeError):validate_manifest(value)
    def test_renamed_cross_split_source(self):
        value=self.manifest();clones=copy.deepcopy(value['cases'])
        for c in clones:c.update(id=c['id']+'-copy',family='renamed',split='heldout')
        value['cases']+=clones;value.update(families=2,pageCount=120)
        with self.assertRaisesRegex(RuntimeError,'cross-split-source'):validate_manifest(value)
    def test_reordered_and_partial_page_reuse(self):
        for partial in [False,True]:
            value=self.manifest();clones=copy.deepcopy(value['cases'])
            for c in clones:
                c.update(id=c['id']+'-copy',family='renamed',split='heldout',sha256='f'*64,sourceLayoutHash='1'*64,sourceContentHash='2'*64)
                c['pageContentHashes']=list(reversed(c['pageContentHashes']))
                if partial:c['pageContentHashes'][1:]=[identity_hash('new'+str(n)) for n in range(9)]
            value['cases']+=clones;value.update(families=2,pageCount=120)
            with self.assertRaisesRegex(RuntimeError,'cross-split-page-content'):validate_manifest(value)
    def test_page_order_and_reference_binding(self):
        refs=[{'expectedMarkdown':'First'},{'expectedMarkdown':'Second'}]
        case={'family':'a','split':'train','pageIds':['a:1','a:2'],'pageReferenceHashes':[identity_hash(r) for r in refs],'pageContentHashes':[page_content_hash(r) for r in refs]}
        labels={'family':'a','split':'train','pages':[{**r,'pageId':p} for r,p in zip(refs,case['pageIds'])]}
        validate_labels(labels,case,2)
        labels['pages'].reverse()
        with self.assertRaises(RuntimeError):validate_labels(labels,case,2)
        labels['pages'].reverse();labels['pages'][0]['expectedMarkdown']='Changed'
        with self.assertRaises(RuntimeError):validate_labels(labels,case,2)
    def test_dropped_whole_family(self):
        panel={'schema':'mixed-pdf-panel@v2','split':'train','cases':[{'id':'a'},{'id':'b'}]}
        completed={**panel,'schema':'mixed-pdf-complete@v2','panelHash':identity_hash(panel),'cases':[{'id':'a'}]}
        with self.assertRaises(RuntimeError):validate_panel_binding(completed,panel,identity_hash(panel))
    def test_sealing_allows_geometry_but_never_content_or_page_order(self):
        from seal import semantic_reference
        refs=[{'pageId':'a','expectedMarkdown':'Value 17','blocks':[{'text':'Value 17','bbox':[0,0,20,20]}]},
              {'pageId':'b','expectedMarkdown':'Value 28','blocks':[{'text':'Value 28','bbox':[0,20,20,40]}]}]
        moved=copy.deepcopy(refs);moved[0]['blocks'][0]['bbox']=[1,2,21,22]
        moved[0]['geometryTransform']={'skewDegrees':.5}
        self.assertEqual(semantic_reference(refs),semantic_reference(moved))
        moved[0]['blocks'][0]['text']='Value 28'
        self.assertNotEqual(semantic_reference(refs),semantic_reference(moved))
        self.assertNotEqual(semantic_reference(refs),semantic_reference(list(reversed(refs))))
    def test_hash_covers_every_dependency(self):
        identity={'labels':'a','scorer':'b','ocr':'c','language':'d','renderer':'e','toolVersions':{'qpdf':'f'}}
        for key in identity:
            changed=copy.deepcopy(identity);changed[key]='changed'
            self.assertNotEqual(identity_hash(identity),identity_hash(changed))
    def test_receipt_and_label_validation_fail_closed(self):
        with self.assertRaises(RuntimeError):validate_policy_receipt({}, {},'x','y')
        receipt={'schema':'mixed-pdf-policy@v2','evaluationIdentity':{},'optimizerHash':'x','tuningInventoryHash':'y','policy':{'mode':'native'}}
        validate_policy_receipt(receipt,{},'x','y')
        with self.assertRaises(RuntimeError):validate_policy_receipt(receipt,{'changed':True},'x','y')
        with self.assertRaises(RuntimeError):validate_labels({'family':'f','split':'train','pages':[{},{}]}, {'family':'f','split':'train'},1)
    def test_inventory_cannot_claim_heldout_as_tune(self):
        with self.assertRaises(RuntimeError):validate_complete_inventory({'schema':'mixed-pdf-complete@v2','split':'heldout','cases':[]},'tune')

if __name__=='__main__':unittest.main()
