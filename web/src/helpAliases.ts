/**
 * Display-time alias filtering for the help surfaces.
 *
 * The command catalog deliberately carries reference non-ASCII spellings
 * (e.g. the Chinese aliases 计划/压缩/目标/导出/权限/反馈) as typed/searchable
 * aliases. The product UI is English-only, so help-style "also:" lines render
 * ASCII/Latin aliases only. This is display-only: resolution, search haystacks
 * and picker matching keep seeing every alias (`findBaseCommand`,
 * `resolveTypedCommand`, `baseCommandMatchesQuery` are untouched).
 */

import { isTypeableCommandToken } from './basecommands'
import type { BaseCommand } from './types'

/** Aliases a help surface may render: ASCII/Latin spellings only. */
export function displayCommandAliases(command: BaseCommand): string[] {
  return command.aliases.filter(isTypeableCommandToken)
}
