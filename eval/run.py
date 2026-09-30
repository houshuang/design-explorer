#!/usr/bin/env python3
"""Paired real-model generation; usage is logged by limbic's subscription transport."""
import argparse
import concurrent.futures
import hashlib
import json
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys

sys.path.insert(0, str(Path.home() / 'src/limbic'))
from limbic.cerebellum.claude_cli import generate

REPO = Path(__file__).resolve().parents[1]
BASE = '083f73d146a76e250b284b39c6169c49f6f097e8'
SCHEMA = {'type': 'object', 'properties': {'files': {'type': 'array', 'items': {
    'type': 'object', 'properties': {'name': {'type': 'string'}, 'content': {'type': 'string'}},
    'required': ['name', 'content'], 'additionalProperties': False,
}}}, 'required': ['files'], 'additionalProperties': False}


def run(mode, case, repeat, args):
    name = f'{args.model}-{case}-{mode}-{repeat}'
    out = args.output / name
    if (out / 'result.json').exists():
        print(f'cached {name}', flush=True)
        return
    out.mkdir(parents=True, exist_ok=True)
    fixture = REPO / 'eval/fixtures' / case
    inputs = '\n\n'.join(f'FILE {p.relative_to(fixture)}\n{p.read_text()}'
                         for p in sorted(fixture.rglob('*')) if p.is_file() and p.name != 'brief.txt')
    skill = (subprocess.check_output(['git', 'show', f'{BASE}:SKILL.md'], cwd=REPO, text=True)
             if mode == 'original' else (REPO / 'SKILL.md').read_text())
    references = '' if mode == 'original' else '\n\n' + (REPO / 'references/fragments.md').read_text()
    restriction = ('Return exactly three self-contained mockup-*.html files. Inline the supplied styles, '
                   'page content and any required fixture data in each HTML fragment, as the original workflow requires.'
                   if mode == 'original' else
                   'Shared input files already exist in the workspace. Return exactly three variants using '
                   'the revised skill format. Do not output copies of existing shared files. Raw HTML remains '
                   'available when it improves the design. Spend your effort on visual quality and useful differences.')
    prompt = (f'Use the supplied design exploration skill for this real design task. This evaluation covers '
              f'creating a complete reviewable round, so do not start a server or wait for feedback. '
              f'Return the files to write, using the response schema.\n\nTASK\n{(fixture / "brief.txt").read_text()}'
              f'\n\n{restriction}\n\nSKILL\n{skill}{references}\n\nEXISTING PROJECT INPUTS\n{inputs}')
    (out / 'prompt.txt').write_text(prompt)
    print(f'start {name}', flush=True)
    result, meta = generate(prompt, project='design-explorer-eval', purpose=name, model=args.model,
                            schema=SCHEMA, timeout=540, max_budget=8, minimal_headless=True)
    db = Path.home() / '.local/share/limbic/llm_costs.db'
    with sqlite3.connect(db) as conn:
        conn.row_factory = sqlite3.Row
        row = conn.execute('SELECT * FROM llm_costs WHERE id = ?', (meta.get('call_id'),)).fetchone()
        usage = dict(row) if row else {}
    meta.update({'usage': usage, 'mode': mode, 'case': case, 'repeat': repeat,
                 'base': BASE, 'skill_sha256': hashlib.sha256(skill.encode()).hexdigest()})
    workspace = args.mockups / name
    workspace.mkdir(parents=True, exist_ok=True)
    if mode != 'original':
        shutil.copytree(fixture / 'shared', workspace / 'shared', dirs_exist_ok=True)
        shutil.copyfile(fixture / 'exploration.json', workspace / 'exploration.json')
    for file in result['files']:
        relative = Path(file['name'])
        if relative.is_absolute() or '..' in relative.parts:
            raise ValueError(f'Unsafe output path: {relative}')
        target = workspace / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(file['content'])
    (out / 'metadata.json').write_text(json.dumps(meta, indent=2))
    (out / 'result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2))
    print(f'complete {name}: {meta["duration_s"]}s, {usage.get("completion_tokens")} output tokens', flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--mode', choices=['original', 'revised', 'both'], default='both')
    parser.add_argument('--model', default='sonnet')
    parser.add_argument('--cases', default='nrk,skard')
    parser.add_argument('--repeats', type=int, default=1)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--mockups', type=Path, required=True)
    args = parser.parse_args()
    modes = ['original', 'revised'] if args.mode == 'both' else [args.mode]
    jobs = [(mode, case, repeat) for repeat in range(1, args.repeats + 1)
            for case in args.cases.split(',') for mode in modes]
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(run, *job, args) for job in jobs]
        for future in futures:
            future.result()


if __name__ == '__main__':
    main()
