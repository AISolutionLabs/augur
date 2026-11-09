import { DataSourceInstanceSettings } from '@grafana/data';
import { DataSourceWithBackend } from '@grafana/runtime';

import { ClaudeQuery, ClaudeDataSourceOptions } from './types';

/**
 * Chat backend for the Claude app. Calls go through resources:
 *   POST /api/datasources/uid/<uid>/resources/messages
 *   GET  /api/datasources/uid/<uid>/resources/config
 */
export class DataSource extends DataSourceWithBackend<ClaudeQuery, ClaudeDataSourceOptions> {
  constructor(instanceSettings: DataSourceInstanceSettings<ClaudeDataSourceOptions>) {
    super(instanceSettings);
  }

  filterQuery(): boolean {
    return false;
  }
}
