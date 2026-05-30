{
  "task": "Editor usability improvements for checkbox/task and bullet/list editing only",
  "scope": {
    "include": [
      "source-backed task checkbox toggle command/keymap exposure",
      "checkbox projection polish",
      "bullet/task list source-transform commands",
      "indent/outdent for unordered/task list lines"
    ],
    "exclude": [
      ".zbase/DataViews changes",
      "full table widget/editor",
      "public third-party plugin API changes",
      "new dependencies"
    ]
  },
  "planning_artifacts": {
    "context_snapshot": ".omx/context/editor-usability-checkbox-bullets-20260530T132204Z.md",
    "prd": ".omx/plans/prd-editor-usability-checkbox-bullets-20260530T132250Z.md",
    "test_spec": ".omx/plans/test-spec-editor-usability-checkbox-bullets-20260530T132250Z.md"
  },
  "ralplan_architect_review": {
    "agent_id": "019e7912-0970-70e0-a502-16b62cd42a91",
    "verdict": "APPROVE",
    "summary": "Architecture approved after fixing context reference, bullet-toggle task-line exclusion, rejected generalized abstraction, risk mitigations, table raw-source verification, and task-only/mixed bullet tests."
  },
  "ralplan_critic_review": {
    "agent_id": "019e7913-1105-7ba2-ac76-84caa02eb42b",
    "verdict": "APPROVE",
    "summary": "Critic approved revised PRD/test spec as actionable, verifiable, aligned with source-backed CodeMirror commands and Live Preview projection boundaries."
  },
  "ralplan_consensus_gate": {
    "complete": true,
    "order": ["architect", "critic"],
    "approved_at": "2026-05-30T13:22:50Z"
  },
  "recommended_execution": {
    "default": "$ultragoal",
    "parallel_option": "$team for disjoint implementation/test lanes if desired",
    "ralph_fallback": "$ralph only if a single-owner persistent verification loop is explicitly selected"
  },
  "verification": [
    "pnpm vitest run tests/editor-task-toggle.test.ts tests/editor-markdown-keymap.test.ts tests/editor-markdown-list-commands.test.ts tests/editor-live-preview-primitives.test.ts tests/desktop-live-preview-styles.test.ts",
    "pnpm typecheck",
    "pnpm lint"
  ]
}
