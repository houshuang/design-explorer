#!/usr/bin/env python3
"""Equal screenshot-driven repair passes for both broad-layout workflows."""
import argparse
import concurrent.futures
import json
from pathlib import Path
import shutil
import sqlite3
import sys

sys.path.insert(0,str(Path.home()/'src/limbic'))
from limbic.cerebellum.claude_cli import generate

REPO=Path(__file__).resolve().parents[1]

def repair(mode,args):
    result_file=args.output/f'repair-hirsch-{mode}.json'
    if result_file.exists():print(f'cached repair {mode}',flush=True);return
    source=Path('/tmp/claude/design-explorer/mockups/efficiency-eval-20260930')/f'sonnet-hirsch-{mode}-1'
    dest=args.mockups/f'sonnet-hirsch-{mode}-1'
    if not dest.exists():shutil.copytree(source,dest)
    manifest=json.loads((args.output/'screenshots/manifest.json').read_text())
    mapping=json.loads((args.output/'judge-hirsch-mapping.json').read_text())
    judge=json.loads((args.output/'judge-hirsch.json').read_text())
    group=next(k for k,v in mapping.items() if v==mode)
    problems=next(x['problems'] for x in judge['groups'] if x['group']==group)
    images=[x['screenshot'] for x in manifest if x['dir']==source.name]
    prompt=(f'Rendered screenshots of your three UI previews have been independently reviewed. '
            f'Inspect the screenshots with Read, then fix the reported visible defects and verify the '
            f'result in the actual source. Your exclusive write scope is {dest}; preserve the existing '
            f'design directions, research facts and typography. Do not alter other workspaces. Use '
            f'surgical edits rather than rewriting whole pages. Return a concise description of changes '
            f'and any remaining limitations. Do not launch agents/models or submit reviewer feedback. '
            f'The harness will render the final result again.\n\nOriginal brief:\n'
            f'{(REPO/"eval/fixtures/hirsch/brief.txt").read_text()}\n\nReview notes:\n'+
            '\n'.join(problems)+'\n\nScreenshots to inspect:\n'+'\n'.join(images))
    (args.output/f'repair-hirsch-{mode}-prompt.txt').write_text(prompt)
    print(f'start repair {mode}',flush=True)
    result,meta=generate(prompt,project='design-explorer-eval',purpose=f'broad-quality-repair-{mode}',
                         model='sonnet',tools='Read,Edit,Write,Bash',allowed_tools='Read,Edit,Write,Bash',
                         max_budget=8,work_dir=str(dest),timeout=540,minimal_headless=True)
    with sqlite3.connect(Path.home()/'.local/share/limbic/llm_costs.db') as conn:
        conn.row_factory=sqlite3.Row
        row=conn.execute('SELECT * FROM llm_costs WHERE id=?',(meta['call_id'],)).fetchone()
        meta['usage']=dict(row) if row else {}
    result_file.write_text(json.dumps({'result':result,'metadata':meta},ensure_ascii=False,indent=2))
    print(f'complete repair {mode}: {meta["duration_s"]}s, {meta["usage"].get("completion_tokens")} output tokens',flush=True)

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--mockups',type=Path,required=True);args=parser.parse_args()
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        futures=[pool.submit(repair,mode,args) for mode in ['original','revised']]
        for future in futures:future.result()

if __name__=='__main__':main()
