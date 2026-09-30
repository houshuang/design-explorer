#!/usr/bin/env python3
"""Exercise the rewritten skill with real file and CLI tools in a private exploration."""
import argparse
import json
from pathlib import Path
import sys

sys.path.insert(0,str(Path.home()/'src/limbic'))
from limbic.cerebellum.claude_cli import generate
from limbic.cerebellum.codex_cli import codex_research

REPO=Path(__file__).resolve().parents[1]

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--output',type=Path,required=True);parser.add_argument('--provider',choices=['claude','codex'],default='claude')
    args=parser.parse_args()
    result_file=args.output/f'agent-{args.provider}-result.json'
    if args.provider=='claude' and (args.output/'agent-result.json').exists():result_file=args.output/'agent-result.json'
    if result_file.exists():print('cached agent workflow');return
    fixture=REPO/'eval/fixtures/nrk'
    prompt=(f'Use the design-explorer skill at {REPO}/SKILL.md to complete the request in '
            f'{fixture}/brief.txt. This is an isolated workflow test. Read the actual skill and its '
            f'relevant reference. Use its real helpers and file tools to create three polished variants. '
            f'The approved project inputs are in {fixture}; copy its shared directory and exploration.json '
            f'into your new exploration rather than rewrite them. Your write scope is a NEW directory '
            f'inside /tmp/claude/design-explorer/mockups/agent-eval-20260930. Do not edit project inputs '
            f'or other explorations. For this candidate test, replace the installed helper path in the '
            f'skill with {REPO}/bin, and pass --port 10079 to every CLI call that contacts the server. '
            f'For begin/register, also pass --state-dir {args.output}/server-state. The testing harness '
            f'will inspect the rendering after your run. Stop after presenting the review URL and the '
            f'actual numbered lineup; do not wait for feedback or submit it yourself. Do not launch '
            f'other models or agents. Preserve the visual quality and all existing programme facts.')
    prompt+=f'\nUse the new directory /tmp/claude/design-explorer/mockups/agent-eval-20260930/{args.provider}-report-placement, which is reserved for your run.'
    (args.output/f'agent-{args.provider}-prompt.txt').write_text(prompt)
    if args.provider=='codex':
        result=codex_research(prompt,scratch_dir=str(args.output/'agent-codex-workspace'),add_dirs=['/tmp/claude/design-explorer/mockups/agent-eval-20260930',str(args.output/'server-state')],model='gpt-6.1-sol',reasoning='medium',timeout=540,web_search=False,network=True,project='design-explorer-eval',purpose='agentic-rewritten-skill-codex')
        result_file.write_text(json.dumps({'result':result},ensure_ascii=False,indent=2))
        print(result,flush=True)
        return
    result,meta=generate(prompt,project='design-explorer-eval',purpose='agentic-rewritten-skill',
                         model='sonnet',tools='Read,Write,Edit,Bash',allowed_tools='Read,Write,Edit,Bash',
                         max_budget=8,work_dir=str(REPO),timeout=540,minimal_headless=True)
    result_file.write_text(json.dumps({'result':result,'metadata':meta},ensure_ascii=False,indent=2))
    print(json.dumps({'result':result,'turns':meta['turns'],'duration_s':meta['duration_s']},ensure_ascii=False),flush=True)

if __name__=='__main__':main()
