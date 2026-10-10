/**
 * Three tips, once.
 *
 * Shown the first time someone opens a document in this browser, then never
 * again unless they ask. Three steps because that is the whole loop for most
 * people: change it, check it on a phone, put it online.
 */

import { useState } from 'react';
import { Icon } from './Icon.tsx';

const KEY = 'playground.tips';

const TIPS = [
  { title: 'Change anything', body: 'Click something on the page to select it. Double-click text to rewrite it. Colours and sizes are in the panel on the right.' },
  { title: 'Check it on a phone', body: 'Use the laptop and phone buttons at the bottom to see how the page looks on each.' },
  { title: 'Put it online', body: 'When you are happy, press Publish at the top right to get a link anyone can open.' },
];

export function FirstRunTips() {
  const [step, setStep] = useState(() => {
    try { return localStorage.getItem(KEY) === 'done' ? -1 : 0; } catch { return -1; }
  });
  if (step < 0) return null;

  const done = () => {
    setStep(-1);
    try { localStorage.setItem(KEY, 'done'); } catch { /* shown again next time; harmless */ }
  };
  const tip = TIPS[step]!;
  const last = step === TIPS.length - 1;

  return (
    <div className="first-run" role="dialog" aria-label="Getting started">
      <div className="first-run-head">
        <span className="dim">Tip {step + 1} of {TIPS.length}</span>
        <button className="icon-button" aria-label="Close tips" onClick={done}><Icon name="close" size={13} /></button>
      </div>
      <strong>{tip.title}</strong>
      <p>{tip.body}</p>
      <div className="first-run-actions">
        <button className="button subtle" onClick={done}>Skip</button>
        <button className="button primary" onClick={() => (last ? done() : setStep(step + 1))}>
          {last ? 'Got it' : 'Next'}
        </button>
      </div>
    </div>
  );
}
