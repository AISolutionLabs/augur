import { DataSourcePlugin } from '@grafana/data';
import { DataSource } from './datasource';
import { ConfigEditor } from './components/ConfigEditor';
import { ClaudeQuery, ClaudeDataSourceOptions } from './types';

export const plugin = new DataSourcePlugin<DataSource, ClaudeQuery, ClaudeDataSourceOptions>(DataSource).setConfigEditor(
  ConfigEditor
);
