// PromptFlowCanvas.jsx — inspect what each seat actually receives.
//
// An overlay showing the prompt assembly pipeline for one seat as a vertical
// flow of nodes: each stage's exact text, char count, and whether it applies
// to this agent. v1 is inspect-only; the stage structure (promptStages.js)
// already supports per-stage disabling, so live toggles are a small follow-up.
//
// Usage from App.jsx:
//   const [flowAgentId, setFlowAgentId] = useState(null);
//   {flowAgentId && (
//     <PromptFlowCanvas
//       agent={agents.find((a) => a.id === flowAgentId)}
//       agents={seated}
//       mode={mode}
//       onPickAgent={setFlowAgentId}
//       onClose={() => setFlowAgentId(null)}
//     />
//   )}

import { useMemo, useState } from 'react';
import { buildPromptStages, assemblePrompt } from './promptStages.js';

function copyText(text) {
  navigator.clipboard?.writeText(text).catch(() => {});
}

export default function PromptFlowCanvas({ agent, agents = [], mode, onPickAgent, onClose }) {
  const [copied, setCopied] = useState(false);
  const stages = useMemo(
    () => (agent ? buildPromptStages(agent, mode) : []),
    [agent, mode]
  );
  const assembled = useMemo(() => assemblePrompt(stages), [stages]);
  const active = stages.filter((s) => s.applies && s.text);

  if (!agent) return null;

  function copyFlow() {
    const flow = stages
      .map((s, i) => {
        const status = s.applies ? `${s.text.length} chars` : 'not applied';
        return `[${i + 1}] ${s.label} (${status})\n${s.applies ? s.text : `(skipped — ${s.why})`}`;
      })
      .join('\n\n----------------------------------------\n\n');
    copyText(`Prompt flow — ${agent.name} (mode: ${mode})\n\n${flow}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="pfc-backdrop" onClick={onClose}>
      <div className="pfc" onClick={(e) => e.stopPropagation()}>
        <header className="pfc-head">
          <div>
            <strong>Prompt Flow</strong>
            <span className="pfc-sub">
              what {agent.name} actually receives · mode: {mode} · {active.length}/{stages.length} stages · {assembled.length} chars
            </span>
          </div>
          <div className="pfc-head-actions">
            {agents.length > 1 && (
              <select
                className="pfc-seat-select"
                value={agent.id}
                onChange={(e) => onPickAgent?.(e.target.value)}
                title="Inspect another seat"
              >
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
            )}
            <button className="pfc-btn" onClick={copyFlow}>
              {copied ? 'Copied ✓' : 'Copy flow'}
            </button>
            <button className="pfc-btn pfc-close" onClick={onClose} title="Close">✕</button>
          </div>
        </header>

        <div className="pfc-scroll">
          {stages.map((s, i) => (
            <div key={s.id} className={`pfc-node ${s.applies ? '' : 'pfc-skip'}`}>
              <div className="pfc-node-head">
                <span className="pfc-num">{i + 1}</span>
                <span className="pfc-label">{s.label}</span>
                <span className="pfc-chars">
                  {s.applies ? `${s.text.length} chars` : 'not applied'}
                </span>
              </div>
              <div className="pfc-why">{s.why}</div>
              {s.applies && s.text && <pre className="pfc-text">{s.text}</pre>}
              {i < stages.length - 1 && <div className="pfc-arrow">▼</div>}
            </div>
          ))}

          <div className="pfc-node pfc-final">
            <div className="pfc-node-head">
              <span className="pfc-num">=</span>
              <span className="pfc-label">Assembled system prompt</span>
              <span className="pfc-chars">{assembled.length} chars</span>
            </div>
            <div className="pfc-why">
              Exactly what is sent as {agent.name}'s system prompt this turn.
              (Transcript messages are added separately per turn.)
            </div>
            <pre className="pfc-text">{assembled}</pre>
          </div>
        </div>

        <footer className="pfc-foot">
          Stages are the real assembly pipeline, not a description of it — this
          view reads from the same code path the orchestrator uses.
        </footer>
      </div>
    </div>
  );
}
