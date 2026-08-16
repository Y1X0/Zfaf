import type { ReactElement } from 'react';

/**
 * What a guest sees when there is no invitation to show (D6.4).
 *
 * The three cases say genuinely different things, and merging them would be
 * both unkind and dishonest. Someone opening a link to a wedding that has
 * happened should be told so, not left thinking they mistyped. Someone opening
 * one we removed should not be told it merely expired. And everything else
 * says the same thing precisely so that a stranger cannot learn from us which
 * slugs exist.
 *
 * Plain, self-contained and tiny: these responses are never cached, so they
 * are generated on every hit, and they carry no script at all.
 */

export type UnavailableKind = 'NOT_FOUND' | 'GONE' | 'BLOCKED';

const COPY: Record<UnavailableKind, { title: string; body: string }> = {
  NOT_FOUND: {
    title: 'الدعوة غير موجودة',
    body: 'تأكّد من الرابط، أو اطلب من صاحب الدعوة إرساله مرة أخرى.',
  },
  GONE: {
    title: 'انتهت هذه الدعوة',
    body: 'كانت هذه الدعوة متاحة سابقاً ولم تعد كذلك.',
  },
  BLOCKED: {
    title: 'هذه الدعوة غير متاحة',
    body: 'أُوقفت هذه الدعوة عن العرض. إن كنت صاحبها، تواصل معنا.',
  },
};

export function UnavailableDocument({ kind }: { kind: UnavailableKind }): ReactElement {
  const copy = COPY[kind];

  return (
    <html lang="ar" dir="rtl">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{copy.title}</title>
        <meta name="robots" content="noindex, nofollow" />
        <style>{STYLESHEET}</style>
      </head>
      <body>
        <main className="zf-empty" data-unavailable={kind}>
          <h1 className="zf-empty__title">{copy.title}</h1>
          <p className="zf-empty__body">{copy.body}</p>
        </main>
      </body>
    </html>
  );
}

const STYLESHEET = `
body{margin:0;min-block-size:100vh;display:grid;place-items:center;padding:2rem;
background:#fffdf8;color:#241f1a;
font-family:system-ui,-apple-system,'Segoe UI',sans-serif;line-height:1.7}
.zf-empty{max-inline-size:32rem;text-align:center}
.zf-empty__title{font-size:1.6rem;margin-block:0 .75rem}
.zf-empty__body{margin:0;color:#5c5348}
`.trim();
