import Md, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * Agent responses rendered as Markdown (GitHub flavor: tables, task lists, strikethrough).
 * Loaded lazily from the detail panel so the board's first load stays small.
 * - Raw HTML in the text is never rendered (react-markdown escapes it); unsafe URLs are dropped by its urlTransform
 * - Links open in a new tab
 * - Images are not fetched — loading a remote image would tell its server the board was opened — so they show as links
 */
const components: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-sky-600 underline underline-offset-2 hover:text-sky-500 dark:text-sky-400">
      {children}
    </a>
  ),
  img: ({ src, alt }) =>
    typeof src === 'string' && src ? (
      <a href={src} target="_blank" rel="noopener noreferrer" className="text-sky-600 underline underline-offset-2 dark:text-sky-400">
        {alt || src}
      </a>
    ) : (
      <span>{alt}</span>
    ),
  h1: ({ children }) => <h4 className="mt-3 mb-1.5 text-base font-semibold text-zinc-800 first:mt-0 dark:text-zinc-100">{children}</h4>,
  h2: ({ children }) => <h4 className="mt-3 mb-1.5 text-[0.9375rem] font-semibold text-zinc-800 first:mt-0 dark:text-zinc-100">{children}</h4>,
  h3: ({ children }) => <h5 className="mt-2.5 mb-1 text-sm font-semibold text-zinc-800 first:mt-0 dark:text-zinc-100">{children}</h5>,
  h4: ({ children }) => <h6 className="mt-2 mb-1 text-sm font-semibold text-zinc-700 first:mt-0 dark:text-zinc-200">{children}</h6>,
  h5: ({ children }) => <h6 className="mt-2 mb-1 text-sm font-medium text-zinc-700 first:mt-0 dark:text-zinc-200">{children}</h6>,
  h6: ({ children }) => <h6 className="mt-2 mb-1 text-sm font-medium text-zinc-700 first:mt-0 dark:text-zinc-200">{children}</h6>,
  p: ({ children }) => <p className="my-1.5 first:mt-0 last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="my-1.5 list-disc space-y-0.5 pl-5">{children}</ul>,
  ol: ({ children, start }) => (
    <ol start={start} className="my-1.5 list-decimal space-y-0.5 pl-5">
      {children}
    </ol>
  ),
  // A task item shows its checkbox instead of a bullet (a list may mix both)
  li: ({ children, className }) => (
    <li className={`marker:text-zinc-400 [&>input]:mr-1.5 [&>input]:align-middle ${className?.includes('task-list-item') ? '-ml-5 list-none' : ''}`}>{children}</li>
  ),
  blockquote: ({ children }) => <blockquote className="my-2 border-l-2 border-zinc-300 pl-3 text-zinc-500 dark:border-zinc-600">{children}</blockquote>,
  hr: () => <hr className="my-3 border-zinc-200 dark:border-zinc-700" />,
  strong: ({ children }) => <strong className="font-semibold text-zinc-800 dark:text-zinc-100">{children}</strong>,
  pre: ({ children }) => (
    <pre className="my-2 overflow-x-auto rounded-md bg-zinc-100 px-3 py-2 font-mono text-[0.8125rem] leading-relaxed text-zinc-800 dark:bg-zinc-800/70 dark:text-zinc-200 [&>code]:bg-transparent [&>code]:p-0">
      {children}
    </pre>
  ),
  code: ({ children }) => <code className="rounded bg-zinc-100 px-1 py-px font-mono text-[0.8125rem] text-zinc-800 dark:bg-zinc-800 dark:text-zinc-200">{children}</code>,
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto">
      <table className="w-max min-w-full border-collapse text-[0.8125rem]">{children}</table>
    </div>
  ),
  th: ({ children, style }) => (
    <th style={style} className="border border-zinc-200 bg-zinc-50 px-2 py-1 text-left font-semibold text-zinc-700 dark:border-zinc-700 dark:bg-zinc-800/60 dark:text-zinc-200">
      {children}
    </th>
  ),
  td: ({ children, style }) => (
    <td style={style} className="border border-zinc-200 px-2 py-1 align-top dark:border-zinc-700">
      {children}
    </td>
  ),
};

export default function Markdown({ text }: { text: string }) {
  return (
    <Md remarkPlugins={[remarkGfm]} components={components}>
      {text}
    </Md>
  );
}
