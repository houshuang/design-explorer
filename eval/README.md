# Real-model evaluation

The evaluation compares the original skill at `083f73d146a76e250b284b39c6169c49f6f097e8` with the rewritten workflow. It uses three tasks drawn from actual design-explorer usage, rather than synthetic empty dashboards:

- Kulturbase: three placements for reporting a programme error, with the same real programme page and closed dialog.
- SKARD: seven textbook appearances on a person page, with an approved visual identity and fixed curriculum section.
- Hirsch: three whole-page research-claim directions with eight supplied reasoning nodes, no fixed identity or page shell.

Chat-history investigation used claude-chat-search. The surviving mockups supplied the concrete content and constraints; the fixtures preserve those in bounded files. Earlier conversation evidence included drift from an approved identity, ambiguity between numbered designs, rounds failing when feedback came in chat, and repeated full-page output for small decisions.

## Results, 30 September 2026

Sonnet resolved to `claude-sonnet-5-5`. Each paired generation produced exactly three designs from the same brief and facts. The original condition emitted self-contained HTML with repeated fixed inputs; the revised condition reused supplied shared files and could still emit raw HTML. No output-token ceiling or reduction in alternatives was used. This measures emitted-artifact efficiency, not the best possible original workflow using every available scripting optimisation.

| Task | Original output tokens | Revised output tokens | Reduction | Original seconds | Revised seconds |
| --- | ---: | ---: | ---: | ---: | ---: |
| Report placement | 9,901 | 5,095 | 48.5% | 53.8 | 33.5 |
| Textbook grouping | 16,038 | 7,013 | 56.3% | 87.3 | 42.3 |
| Broad claim layouts, first pass | 17,352 | 15,782 | 9.0% | 95.4 | 94.3 |
| Broad layouts, including equal repair passes | 20,986 | 21,986 | **4.8% more** | 123.8 | 136.4 |

Generation timing includes each CLI call; it excludes screenshot capture and judging. Repair tokens include tool output, not just final HTML. Input/cache/reasoning accounting varies by transport; no input-token saving is claimed. Usage comes from the canonical limbic transport ledger, not character estimates.

### Quality checks

All 18 first-pass designs rendered at 1280px and 390px without page-script errors or horizontal document overflow. These checks do not establish visual quality by themselves.

An independent GPT-6.1-sol call received the raw brief/content and blinded, randomised A/B screenshot groups. It did not see the skill, creator, code or efficiency metrics. It scored craft, clarity, useful variation, mobile usability and factual fidelity, named visible defects and stated screenshot limitations.

| Case | Blind preference | Findings |
| --- | --- | --- |
| Report placement | Revised | Stronger clarity/craft; both retained a dangling separator, and revised mobile header treatments varied slightly. |
| Textbook grouping | Revised | Clearer evidence and mobile reading; both chronology designs omitted some supplied editorial/page detail. |
| Broad layouts, first pass | Original, modestly | Revised desktop connectors crossed text and its mobile inspector obscured nodes; original had badge/column and narrow-layout problems. |
| Broad layouts, after equal repairs | Revised, modestly | Better initial claim placement and complete assessments; both sets retained mobile weaknesses. |

The repair round provided each workflow only its own six screenshots, the original brief and its own reviewer findings. Both had the same tools and instruction to preserve directions/facts and make surgical corrections. Original repairs used 3,634 tokens/28.4s; revised repairs used 6,204 tokens/42.1s. Final screenshot judging found no clear material group-wide regression, while identifying remaining per-design issues. Keeping the first-pass preference and repair cost visible avoids overstating quality or savings.

The installed skill explicitly requires screenshot inspection and relevant interaction checks, with particular attention to overlapping badges/connectors, obscured evidence, hidden content and accidental identity drift. Broad layouts remain unrestricted; sharing is optional.

### Tool workflow and interactions

A real tool-enabled Sonnet call read the actual skill/reference, copied approved inputs, used begin/round/lineup and created three variants in nine turns, 30.3s and 3,666 output tokens. It honestly deferred browser checks to the evaluation harness, as permitted by the evaluation prompt.

A separate GPT-6.1-sol tool call used the same workflow and checked desktop/mobile controls before presenting the numbered lineup. It used 8,200 output tokens and about 522s including browser work. This establishes cross-model usability; it is **not** evidence that Codex completed the task quickly or a paired speed comparison.

`verify.js` exercises physical clicks in the actual sandboxed reviewer at both widths: open/close reporting, supplied programme facts, script errors and overflow. It includes original/revised paired variants and both tool-generated sets (24 design/viewport combinations). This exposed two real harness issues: the feedback bar could cover a footer control, and native dialog-form closing was blocked by the sandbox. The reviewer now reserves space for its bar and locally handles dialog-form closing without enabling general form submission. Runtime/browser tests also cover these paths.

There is one pair per task and one judge per comparison. Random model variation and subjective preference remain; these results cannot prove a universal quality guarantee. End-to-end latency, total cost, more models and repeated trials would need larger evaluations. Voice finalisation is tested with simulated transcript delivery; a live microphone/Soniox session was not exercised.

## Reproduce

Requires this Git history, Node, an existing Playwright/Chromium installation, authenticated Claude/Codex CLIs, and Stian's limbic subscription/usage transport at `~/src/limbic`. Calls consume real model usage. Keep them separate from normal runtime tests.

```bash
python3 eval/run.py --cases nrk,skard,hirsch --output /private/evidence --mockups /tmp/claude/design-explorer/mockups/evaluation
DE_PLAYWRIGHT=/absolute/path/to/playwright node eval/capture.js /tmp/claude/design-explorer/mockups/evaluation /private/evidence/screenshots
python3 eval/judge.py --cases nrk,skard,hirsch --output /private/evidence
python3 eval/agent.py --provider claude --output /private/evidence
python3 eval/agent.py --provider codex --output /private/evidence
```

Long model runs should use the machine's sleepsafe wrapper. Results are cached by output path. For a new run, choose a fresh evidence directory. `repair.py` and `agent.py` intentionally use reserved paths/ports for this dated experiment; update them before another run. The paired generator and fixture capture are parameterised. The repair script's source path also needs changing to match a new generation root.

Prompts, returned files, model metadata, screenshots, blind mappings, judges and interaction results for this run are preserved under `/Users/stian/.agents/research/design-explorer-eval-20260930`. It is local evidence, not bundled into the skill. The evaluation fixtures and scripts are committed so the method remains inspectable.
