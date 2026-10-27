import argparse,json,sys
from measure import content_score
p=argparse.ArgumentParser();p.add_argument("--scorers",required=True);a=p.parse_args()
sys.path.insert(0,a.scorers)
import tolerant_markdown
request=json.load(sys.stdin)
print(json.dumps(content_score(request["reference"],request["text"],tolerant_markdown)))
