"""Construction evidence defaults. Scores are ordinal evidence, never probabilities."""
SCALE='evidence-ordinal-not-probability'


def evidence():
 return {
  'source-geometry':{'actor':'editorial Page renderer','actorType':'tool','model':None,'method':'Authored coordinates, measured native glyph bounds and explicit source components','scope':'Native source geometry only; not independently verified visible ink or physical capture geometry','independentOfAuthor':False},
  'source-semantics':{'actor':'source composition author','actorType':'agent','model':None,'method':'Semantic labels assigned during source authoring','scope':'Authored labels awaiting region-specific independent review','independentOfAuthor':False},
  'source-text':{'actor':'editorial Page renderer','actorType':'tool','model':None,'method':'Retains authored text, exact glyph lines, table cells and math expressions before raster publication','scope':'Authored native text/math only; embedded asset text is excluded unless separately annotated','independentOfAuthor':False},
  'source-visibility':{'actor':'editorial Page renderer','actorType':'tool','model':None,'method':'Source-layer extent and supplied visibility; overlapping layers are not independently inspected pixel masks','scope':'Native composition visibility estimate only','independentOfAuthor':False}}


def axis(score,status,basis,provenance,reason=None):
 result={'score':score,'status':status,'basis':basis,'provenance':provenance}
 if reason:result['reason']=reason
 return result


def defaults(region,has_text):
 asset=region['attributes'].get('asset')
 if has_text:
  transcription=axis(.5,'source-derived',['Native authored text/cells/math expressions retained; no independent letter-by-letter check'],['source-text'])
 elif asset:
  transcription=axis(0,'unknown',['Embedded image text has no transcript annotation'],[],reason='Unknown asset text is not treated as known absence or source-gold transcription.')
 else:
  transcription=axis(None,'not-applicable',['Source graphic has no authored text or math'],['source-text'],reason='No text or math occurs in this authored graphical region.')
 return {'scale':SCALE,'axes':{
  'geometry':axis(.5,'source-derived',['Source-command geometry and font metrics recorded before raster publication'],['source-geometry']),
  'semanticLabel':axis(.5,'source-derived',['Authored semantic assignment, not independent review'],['source-semantics']),
  'textTranscription':transcription,
  'visibilityOcclusion':axis(.5,'estimated',['Native rendering/layer visibility estimate; no independent occlusion review'],['source-visibility']),
  'readingOrder':axis(0,'unknown',['No validated reading-order annotation exists'],[])}}
