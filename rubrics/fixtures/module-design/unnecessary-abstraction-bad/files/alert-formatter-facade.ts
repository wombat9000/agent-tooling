import { AlertFormatterFactory } from './alert-formatter-factory';
import type { IAlertFormatterStrategy, SystemAlert } from './i-alert-formatter';

export class AlertFormatterFacade {
  private readonly strategy: IAlertFormatterStrategy;

  constructor(strategy: IAlertFormatterStrategy = AlertFormatterFactory.create('default')) {
    this.strategy = strategy;
  }

  formatAlert(alert: SystemAlert): string {
    return this.strategy.format(alert);
  }
}
