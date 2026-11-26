import { DefaultAlertFormatterStrategy } from './default-alert-formatter';
import type { IAlertFormatterStrategy } from './i-alert-formatter';

export type FormatterStrategyType = 'default';

export class AlertFormatterFactory {
  static create(type: FormatterStrategyType = 'default'): IAlertFormatterStrategy {
    if (type === 'default') {
      return new DefaultAlertFormatterStrategy();
    }
    throw new Error(`Unknown formatter strategy: ${String(type)}`);
  }
}
