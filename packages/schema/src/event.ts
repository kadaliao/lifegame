export type EventType =
  | 'birth' | 'stage' | 'school' | 'exam' | 'job' | 'money' | 'home'
  | 'love' | 'marriage' | 'child' | 'health' | 'death'
  | 'world' | 'decision' | 'reflection' | 'move' | 'misc';

export interface WorldEvent {
  seq: number;
  tick: number;
  type: EventType;
  /** 主体 bot；世界事件为空 */
  botId?: string;
  /** 相关的其他 bot */
  relatedIds?: string[];
  /** 人类可读中文描述 */
  text: string;
  /** 0-10，进入记忆与卷轴的权重 */
  importance: number;
  /** 关联的决策节点 */
  decisionId?: string;
  /** 结构化附加数据 */
  data?: Record<string, unknown>;
}
