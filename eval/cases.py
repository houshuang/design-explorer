#!/usr/bin/env python3
"""Real-model check of data cases: used when the decision needs several entries, absent otherwise.

Each run is a tool-enabled agent following one skill checkout (this branch, or a baseline
checkout for comparison) in its own exploration directory, server port and state directory.
Results are cached per run in the output directory; verify_cases.js then renders them.
"""
import argparse
import json
import shutil
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path.home() / 'src/limbic'))
from limbic.cerebellum.claude_cli import generate
from limbic.cerebellum.codex_cli import codex_research

REPO = Path(__file__).resolve().parents[1]
ROOT = Path('/tmp/claude/design-explorer/mockups')

SCENARIOS = {
    # Cases expected: the brief asks for a light and two dense entities, all in one fixture.
    'timeline': {'fixture': 'timeline', 'brief': None},
    # Same multi-entity fixture, but the decision concerns one entity only: no cases expected.
    'timeline-one': {'fixture': 'timeline', 'brief': (
        'Create exactly three polished colour and weight treatments for the existing compact plan '
        'timeline in the head of the Henrik Ibsen person page (use the ibsen entry in '
        'shared/evidence.json). Keep the approved Læreplanatlas identity and the rest of the page head '
        'fixed. Headline only: no explanatory prose. Plan entries should link to their plan pages. '
        'Desktop 1280px first; it must remain usable at 390px.')},
    # Single-record fixtures from the September evaluation: no cases expected.
    'skard': {'fixture': 'skard', 'brief': None},
    'nrk': {'fixture': 'nrk', 'brief': None},
}


def prompt_for(skill, fixture, brief, run_dir, port, state_dir):
    brief_text = brief or (fixture / 'brief.txt').read_text().strip()
    return (
        f'Use the design-explorer skill at {skill}/SKILL.md to complete the request below. This is an '
        f'isolated workflow test. Read the actual skill and its relevant reference. Use its real helpers '
        f'and file tools to create the variants. The approved project inputs are in {fixture}; copy its '
        f'shared directory and exploration.json into your exploration rather than rewrite them (you may '
        f'edit the copies). Your write scope is the new directory {run_dir}: pass --dir {run_dir} to '
        f'begin. Do not edit project inputs or other explorations. Replace the installed helper path in '
        f'the skill with {skill}/bin, pass --port {port} to every CLI call that contacts the server, and '
        f'for begin/register also pass --state-dir {state_dir}. The testing harness will inspect the '
        f'rendering after your run. Stop after presenting the review URL and the actual numbered lineup; '
        f'do not wait for feedback or submit it yourself. Do not launch other models or agents.\n\n'
        f'Request:\n{brief_text}')


def run(job, output):
    name, skill, scenario, provider, port = job['name'], Path(job['skill']), job['scenario'], job['provider'], job['port']
    result_file = output / f'{name}.json'
    if result_file.exists():
        return name, 'cached'
    spec = SCENARIOS[scenario]
    fixture = REPO / 'eval/fixtures' / spec['fixture']
    run_dir = ROOT / output.name / name
    state_dir = output / 'state' / name
    if run_dir.exists():
        shutil.rmtree(run_dir)
    state_dir.mkdir(parents=True, exist_ok=True)
    prompt = prompt_for(skill, fixture, spec['brief'], run_dir, port, state_dir)
    (output / f'{name}.prompt.txt').write_text(prompt)
    if provider == 'codex':
        result = codex_research(prompt, scratch_dir=str(output / f'{name}-codex'), add_dirs=[str(ROOT / output.name), str(state_dir)],
                                model='gpt-6.1-sol', reasoning='medium', timeout=900, web_search=False, network=True,
                                project='design-explorer-eval', purpose=f'cases-{name}')
        meta = {}
    else:
        result, meta = generate(prompt, project='design-explorer-eval', purpose=f'cases-{name}', model=provider,
                                tools='Read,Write,Edit,Bash', allowed_tools='Read,Write,Edit,Bash',
                                max_budget=8, work_dir=str(skill), timeout=900, minimal_headless=True)
    result_file.write_text(json.dumps({'job': job, 'run_dir': str(run_dir), 'result': result, 'metadata': meta},
                                      ensure_ascii=False, indent=2, default=str))
    return name, 'done'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--jobs', type=Path, required=True, help='JSON list of {name, skill, scenario, provider, port}')
    parser.add_argument('--parallel', type=int, default=3)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    jobs = json.loads(args.jobs.read_text())
    with ThreadPoolExecutor(args.parallel) as pool:
        for name, status in pool.map(lambda job: run(job, args.output), jobs):
            print(name, status, flush=True)


if __name__ == '__main__':
    main()
