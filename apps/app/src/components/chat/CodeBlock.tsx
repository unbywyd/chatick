import { Fragment, useMemo, type ReactNode } from 'react'
import { createLowlight, common } from 'lowlight'

/**
 * Блок кода в ленте сообщений — с подсветкой.
 *
 * Композер уже подсвечивает код при наборе. Без такого же блока у получателя
 * отправитель видел бы цвета, а собеседник — серую простыню, и выглядело бы
 * это поломкой, а не задумкой.
 *
 * Через lowlight, а не через rehype-плагин: lowlight уже стоит ради
 * композера, и второй способ подсветки означал бы два набора грамматик в
 * сборке и два места, где цвета могут разъехаться.
 */
const lowlight = createLowlight(common)

/** Узел разметки lowlight: либо текст, либо элемент с классами. */
type HastNode = {
  type: string
  value?: string
  tagName?: string
  properties?: { className?: string[] }
  children?: HastNode[]
}

/**
 * Дерево lowlight в React-узлы.
 *
 * Своим обходом, а не через hast-util-to-html: тот лежит в дереве только как
 * транзитивная зависимость, и опираться на неё — значит однажды получить
 * сломанную сборку после чужого обновления. Заодно обходимся без
 * dangerouslySetInnerHTML, то есть содержимое сообщения не может стать
 * разметкой.
 */
function render(nodes: HastNode[] = [], keyPrefix = ''): ReactNode[] {
  return nodes.map((n, i) => {
    const key = `${keyPrefix}${i}`
    if (n.type === 'text') return <Fragment key={key}>{n.value}</Fragment>
    const cls = n.properties?.className?.join(' ')
    return (
      <span key={key} className={cls}>
        {render(n.children, `${key}-`)}
      </span>
    )
  })
}

export function CodeBlock({ className, children }: { className?: string; children?: ReactNode }) {
  // ReactMarkdown кладёт язык в класс: ```js → language-js
  const lang = /language-(\w+)/.exec(className ?? '')?.[1]
  const code = String(children ?? '').replace(/\n$/, '')

  /**
   * Строчный код оставляем как есть.
   *
   * ReactMarkdown зовёт этот компонент и для `x = 1` внутри предложения, и
   * для блока. Без разделения строчный код уехал бы в <pre> на всю ширину,
   * разорвав фразу пополам.
   *
   * Признак блока — язык в классе или перенос строки внутри: markdown не
   * ставит language-* строчному коду, а многострочным тот не бывает.
   */
  const isInline = !lang && !code.includes('\n')

  const parts = useMemo(() => {
    // Язык не указан или незнаком — показываем как есть. Угадывать по
    // содержимому не пробуем: неверная подсветка хуже отсутствующей, она
    // врёт о том, на чём написан код.
    if (!lang || !lowlight.registered(lang)) return null
    try {
      return render((lowlight.highlight(lang, code) as unknown as HastNode).children)
    } catch {
      return null
    }
  }, [lang, code])

  // После useMemo, а не до: ранний возврат выше сломал бы порядок хуков.
  if (isInline) {
    return <code className="rounded bg-secondary px-1 py-0.5 text-[0.9em]">{code}</code>
  }

  return (
    <pre className="hljs my-1.5 overflow-x-auto rounded-md bg-secondary p-2.5 text-xs">
      {/* dir=ltr жёстко: код не бывает справа налево, даже внутри ивритского
          сообщения, где направление наследуется от абзаца. */}
      <code dir="ltr" className={className}>
        {parts ?? code}
      </code>
    </pre>
  )
}
