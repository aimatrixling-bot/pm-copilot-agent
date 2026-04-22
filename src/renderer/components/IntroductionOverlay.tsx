/**
 * IntroductionOverlay — Renders INTRODUCTION.md as an immersive backdrop
 * in empty chat sessions. Displays the Agent's usage guide / welcome content.
 *
 * Shown when: session has no messages, not loading, and INTRODUCTION.md exists.
 * Hidden when: user sends first message or session loads history.
 */
import { memo, useEffect, useState } from 'react';

import Markdown from '@/components/Markdown';

interface IntroductionOverlayProps {
  content: string;
}

const IntroductionOverlay = memo(function IntroductionOverlay({ content }: IntroductionOverlayProps) {
  const [visible, setVisible] = useState(false);

  // Trigger enter animation on mount
  useEffect(() => {
    // requestAnimationFrame ensures the initial opacity-0 is painted before transition starts
    const raf = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div
      className={`absolute inset-0 z-[5] overflow-y-auto transition-all duration-300 ease-out ${
        visible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2'
      }`}
    >
      <div className="mx-auto max-w-3xl px-8 pt-12 pb-40">
        <div className="introduction-content">
          <Markdown raw>{content}</Markdown>
        </div>
      </div>
    </div>
  );
});

export default IntroductionOverlay;
