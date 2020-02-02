import chalk, { Chalk } from 'chalk'
import stripAnsi from 'strip-ansi'
import * as util from 'util'
import * as utils from '../utils'
import * as Level from './level'
import * as Logger from './logger'

// Helpful unicode pickers:
// - https://jrgraphix.net/r/Unicode/2600-26FF
// - https://graphemica.com/

const LEVEL_STYLES: Record<
  Level.Level,
  { badge: string; color: chalk.Chalk }
> = {
  fatal: {
    // badge: '⚰',
    // badge: '☠',
    badge: '✕',
    color: chalk.red,
  },
  error: {
    badge: '■',
    color: chalk.red,
  },
  warn: {
    badge: '▲',
    color: chalk.yellow,
  },
  info: {
    // badge: '↣',
    badge: '●',
    color: chalk.green,
  },
  debug: {
    // badge: '◒',
    badge: '○',

    // badge: '⚒',
    // badge: '↺',
    // badge: '↯',
    // badge: '⟐',
    color: chalk.blue,
  },
  trace: {
    badge: '—',
    // badge: '~',
    // badge: '⟣',
    // badge: '⟛',
    // badge: '⠿',
    color: chalk.magenta,
  },
}

const pathSep = {
  symbol: ':',
  color: chalk.gray,
}

const eventSep = ':'

const headersContextSep = {
  singleLine: {
    symbol: '  --  ',
    // context = ` ${chalk.gray('⸬')}  ` + context
    // context = ` ${chalk.gray('•')}  ` + context
    // context = ` ${chalk.gray('⑊')}  ` + context
    // context = ` ${chalk.gray('//')}  ` + context
    // context = ` ${chalk.gray('—')}  ` + context
    // context = ` ${chalk.gray('~')}  ` + context
    // context = ` ${chalk.gray('⌀')}  ` + context
    // context = ` ${chalk.gray('——')}  ` + context
    // context = ` ${chalk.gray('❯')}  ` + context
    // context = ` ${chalk.gray('->')}  ` + context
    // context = ` ${chalk.gray('⌁')}  ` + context
    // context = ` ${chalk.gray('⋯')}  ` + context
    // context = ` ${chalk.gray('⌁')}  ` + context
    // context = ` ${chalk.gray('⟛')}  ` + context
    color: chalk.gray,
  },
  multiline: {
    symbol: '',
  },
}

const contextKeyValSep = {
  singleLine: {
    symbol: ': ',
    color: chalk.gray,
  },
  multiline: {
    symbol: '  ',
  },
}

const contextEntrySep = {
  singleLine: '  ',
  multiline: {
    symbol: `\n  | `,
    color: chalk.gray,
  },
}

type Options = {
  levelLabel: boolean
}

export function create(options: Options) {
  return render.bind(null, options)
}

export function render(options: Options, rec: Logger.LogRecord): string {
  const levelLabel = Level.LEVELS_BY_NUM[rec.level].label
  const style = LEVEL_STYLES[levelLabel]

  // render pre-context

  const levelLabelRendered = options.levelLabel
    ? ' ' + utils.spanSpace(5, levelLabel) + ' '
    : ' '
  const path = rec.path.join(renderEl(pathSep))

  const renderedPreContext = `${style.color(
    `${style.badge}${levelLabelRendered}${path}`
  )}${chalk.gray(eventSep)}${rec.event}`

  // render context

  // Factor in:
  // 1. the headers section
  // 2. the headers/context separator
  const availableSinglelineContextColumns =
    process.stdout.columns -
    stripAnsi(renderedPreContext).length -
    headersContextSep.singleLine.symbol.length
  let contextColumnsConsumed = 0

  const contextEntries = Object.entries(rec.context)
  let widestKey = 0
  let first = true

  const contextEntriesRendered = contextEntries.map(([key, value]) => {
    // Track context space consumption of entry separators
    if (!first) contextColumnsConsumed += contextEntrySep.singleLine.length
    else first = false

    // Track widest key optimistically for use in multiline layout later
    if (key.length > widestKey) widestKey = key.length

    contextColumnsConsumed +=
      key.length + contextKeyValSep.singleLine.symbol.length

    const valueRendered = `${util.inspect(value, {
      breakLength: availableSinglelineContextColumns,
      colors: true,
      getters: true,
      depth: 20,
    })}`

    contextColumnsConsumed += stripAnsi(valueRendered).length

    return [key, valueRendered]
  })

  const contextFitsSingleLine =
    contextColumnsConsumed <= availableSinglelineContextColumns

  let contextRendered = ''
  if (contextEntries.length > 0) {
    if (contextFitsSingleLine) {
      contextRendered =
        renderEl(headersContextSep.singleLine) +
        contextEntriesRendered
          .map(
            ([key, value]) =>
              `${chalk.gray(key)}${renderEl(
                contextKeyValSep.singleLine
              )}${value}`
          )
          .join(contextEntrySep.singleLine)
    } else {
      contextRendered =
        renderEl(headersContextSep.multiline) +
        renderEl(contextEntrySep.multiline) +
        contextEntriesRendered
          .map(
            ([key, value]) =>
              `${chalk.gray(utils.spanSpace(widestKey, key))}${renderEl(
                contextKeyValSep.multiline
              )}${formatBlock(
                {
                  leftSpineSymbol: { color: chalk.gray, symbol: '  | ' }, // todo unify with el def above,
                  excludeFirstLine: true,
                  indent:
                    widestKey +
                    contextKeyValSep.multiline.symbol.length +
                    contextEntrySep.multiline.symbol.length,
                },
                value
              )}`
          )
          .join(renderEl(contextEntrySep.multiline))
    }
  }

  // put it together

  return `${renderedPreContext}${contextRendered}\n`
}

type El = {
  symbol: string
  color?: Chalk
}

function renderEl(el: El) {
  return el.color ? el.color(el.symbol) : el.symbol
}

/**
 * Given a multiline string, run a single pass over each line carrying out the
 * given transformations configured in given options.
 *
 * If singleline given, returned as-is.
 */
function formatBlock(
  opts: {
    indent?: number
    excludeFirstLine?: boolean
    leftSpineSymbol?: El
  },
  block: string
): string {
  const [first, ...rest] = block.split('\n')
  if (rest.length === 0) return first
  const linesToProcess =
    opts.excludeFirstLine === true ? rest : (rest.unshift(first), rest)
  const prefix = opts.leftSpineSymbol?.symbol ?? ''
  const indent =
    opts.indent !== undefined
      ? utils
          .range(opts.indent - prefix.length)
          .map(utils.constant(' '))
          .join('')
      : ''
  const linesProcessed = opts.excludeFirstLine === true ? [first] : []
  for (const line of linesToProcess) {
    const prefixRendered = opts.leftSpineSymbol?.color?.(prefix) ?? prefix
    linesProcessed.push(prefixRendered + indent + line)
  }
  return linesProcessed.join('\n')
}
