#!/usr/bin/env python3
"""Blind screenshot comparison, using an independent model and recorded raw briefs."""
import argparse
import concurrent.futures
import json
from pathlib import Path
import random
import sys

sys.path.insert(0, str(Path.home() / 'src/limbic'))
from limbic.cerebellum.codex_cli import codex_research

REPO=Path(__file__).resolve().parents[1]
SCHEMA={'type':'object','properties':{
    'groups':{'type':'array','items':{'type':'object','properties':{
        'group':{'type':'string','enum':['A','B']},
        'visual_craft':{'type':'number'},'clarity':{'type':'number'},
        'useful_variation':{'type':'number'},'mobile_usability':{'type':'number'},
        'content_fidelity':{'type':'number'},'problems':{'type':'array','items':{'type':'string'}},
    },'required':['group','visual_craft','clarity','useful_variation','mobile_usability','content_fidelity','problems']}},
    'preferred':{'type':'string','enum':['A','B','equal']},
    'quality_regression':{'type':'string'},'reason':{'type':'string'},
},'required':['groups','preferred','quality_regression','reason']}

def judge(case,root,model):
    out=root/f'judge-{case}.json'
    if out.exists():print(f'cached judge {case}',flush=True);return
    manifest=json.loads((root/'screenshots/manifest.json').read_text())
    items=[x for x in manifest if x['round']==case]
    modes=['original','revised'];random.Random('blind-'+case).shuffle(modes)
    groups=dict(zip(['A','B'],modes))
    images=[];labels=[]
    for group,mode in groups.items():
        for entry in sorted([x for x in items if '-'+mode+'-' in x['dir']],key=lambda x:(x['id'],-x['width'])):
            images.append(entry['screenshot']);labels.append(f'Image {len(images)}: Group {group}, design {entry["id"]}, width {entry["width"]} px')
    fixture=REPO/'eval/fixtures'/case
    brief=(fixture/'brief.txt').read_text()
    facts=(fixture/'shared/data.json').read_text() if (fixture/'shared/data.json').exists() else (fixture/'shared/page.html').read_text()
    prompt=('You are independently comparing two rounds of UI design exploration. You are blind to '
            'the generation method, creator and token cost. Evaluate the attached screenshots directly. '
            'Do not use tools, the web, or read other files. Give each group 0–5 scores for visual craft '
            '(intentional typography, spacing, composition), clarity, useful variation between its three '
            'designs, mobile usability, and fidelity to the provided content. Do not reward brevity, '
            'generic layouts, fewer facts, or superficial colour changes. Judge whether either group '
            'suffers a material quality regression. Small preference differences are not proof of a '
            'regression. Screenshots cannot prove interactive behavior; do not claim they do. '
            'State limitations and specific visible problems.\n\nTASK\n'+brief+'\n\nRAW CONTENT\n'+facts+
            '\n\nATTACHMENT ORDER\n'+'\n'.join(labels))
    (root/f'judge-{case}-prompt.txt').write_text(prompt)
    (root/f'judge-{case}-mapping.json').write_text(json.dumps(groups,indent=2))
    print(f'start judge {case}, {len(images)} images',flush=True)
    result=codex_research(prompt,schema=SCHEMA,scratch_dir=str(root/'judge-workspace'),images=images,
                          model=model,reasoning='high',timeout=540,web_search=False,network=False,
                          project='design-explorer-eval',purpose=f'blind-visual-judge-{case}')
    out.write_text(json.dumps(result,ensure_ascii=False,indent=2))
    print(f'complete judge {case}: {result["preferred"]}',flush=True)

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--cases',default='nrk,skard');parser.add_argument('--model',default='gpt-6.1-sol')
    args=parser.parse_args()
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        futures=[pool.submit(judge,case,args.output,args.model) for case in args.cases.split(',')]
        for future in futures:future.result()

if __name__=='__main__':main()
