export const TASK_TYPES = ['a', 'b', 'c', 'd', 'e'];
export const TOKEN_TYPES = [...TASK_TYPES, 'wild'];

export const TASK_INFO = {
  a: { name: '学习', short: '学', color: '#f8fafc' },
  b: { name: '科研', short: '研', color: '#dbeafe' },
  c: { name: '学工', short: '工', color: '#dcfce7' },
  d: { name: '社交', short: '社', color: '#fee2e2' },
  e: { name: '娱乐', short: '娱', color: '#ede9fe' },
  wild: { name: '万能', short: '万', color: '#fef3c7' },
};

export const TOKEN_SUPPLY_BY_PLAYERS = {
  2: { a: 5, b: 5, c: 5, d: 5, e: 5, wild: 5 },
  3: { a: 6, b: 6, c: 6, d: 6, e: 6, wild: 5 },
  4: { a: 8, b: 8, c: 8, d: 8, e: 8, wild: 5 },
};

export const MARKET_SIZE = 5;
export const TOKEN_LIMIT = 10;
export const RESERVE_LIMIT = 3;
export const WINNING_HAPPINESS = 15;
export const GAME_VERSION = '0.3-card-counts';

export const LEVEL1_TEMPLATES = [
  { id: 'L1_001', name: '通宵学习', level: 1, attribute: 'a', cost: { a: 3 }, happiness: 0, copies: 5 },
  { id: 'L1_002', name: '小组作业', level: 1, attribute: 'a', cost: { a: 2, d: 2 }, happiness: 0, copies: 5 },
  { id: 'L1_003', name: '专业课复习', level: 1, attribute: 'a', cost: { a: 2, b: 2 }, happiness: 0, copies: 5 },
  { id: 'L1_004', name: '搜集信息', level: 1, attribute: 'b', cost: { a: 1, b: 1, c: 1, d: 2 }, happiness: 0, copies: 5 },
  { id: 'L1_005', name: '写论文', level: 1, attribute: 'b', cost: { a: 1, b: 3 }, happiness: 0, copies: 5 },
  { id: 'L1_006', name: '联系导师', level: 1, attribute: 'b', cost: { a: 2, b: 2, d: 1 }, happiness: 0, copies: 5 },
  { id: 'L1_007', name: '竞选班干', level: 1, attribute: 'c', cost: { c: 3 }, happiness: 0, copies: 5 },
  { id: 'L1_008', name: '班级活动', level: 1, attribute: 'd', cost: { c: 1, d: 2, e: 1 }, happiness: 0, copies: 5 },
  { id: 'L1_009', name: '学习培训', level: 1, attribute: 'c', cost: { a: 2, c: 2 }, happiness: 0, copies: 5 },
  { id: 'L1_010', name: '线下聚会', level: 1, attribute: 'd', cost: { d: 2, e: 2 }, happiness: 0, copies: 5 },
  { id: 'L1_011', name: '单机游戏', level: 1, attribute: 'e', cost: { e: 3 }, happiness: 1, copies: 5 },
  { id: 'L1_012', name: '组队开黑', level: 1, attribute: 'e', cost: { d: 2, e: 2 }, happiness: 1, copies: 10 },
  { id: 'L1_013', name: '上网冲浪', level: 1, attribute: 'd', cost: { a: 1, b: 1, c: 1, d: 1, e: 1 }, happiness: 0, copies: 10 },
];

export const LEVEL2_TEMPLATES = [
  { id: 'L2_001', name: '专业第一', level: 2, attribute: 'a', cost: { a: 7 }, happiness: 3, copies: 3 },
  { id: 'L2_002', name: '保研上岸', level: 2, attribute: null, cost: {}, flexCost: { type: 'abc-total', amount: 15 }, happiness: 5, copies: 3 },
  { id: 'L2_003', name: '论文产出', level: 2, attribute: 'b', cost: { a: 3, b: 6 }, happiness: 3, copies: 3 },
  { id: 'L2_004', name: '高薪工作', level: 2, attribute: 'b', cost: { a: 2, b: 6, c: 2, d: 2 }, happiness: 4, copies: 3 },
  { id: 'L2_005', name: '优秀干部', level: 2, attribute: 'c', cost: { c: 6, d: 3 }, happiness: 3, copies: 3 },
  { id: 'L2_006', name: '校园名人', level: 2, attribute: 'd', cost: { d: 7 }, happiness: 3, copies: 3 },
  { id: 'L2_007', name: '学习博主', level: 2, attribute: 'd', cost: { a: 5, d: 5 }, happiness: 3, copies: 3 },
  { id: 'L2_008', name: '游戏大神', level: 2, attribute: 'e', cost: { e: 7 }, happiness: 4, copies: 3 },
  { id: 'L2_009', name: '宿舍领袖', level: 2, attribute: null, cost: {}, flexCost: { type: 'same-kind', amount: 8 }, happiness: 4, copies: 6 },
  { id: 'L2_010', name: '丰富生活', level: 2, attribute: null, cost: { a: 3, b: 3, c: 3, d: 3, e: 3 }, happiness: 4, copies: 6 },
];

export const OPPORTUNITY_TEMPLATES = [
  { id: 'O_001', name: '期末考试', attribute: 'a' },
  { id: 'O_002', name: '学术会议', attribute: 'b' },
  { id: 'O_003', name: '优干答辩', attribute: 'c' },
  { id: 'O_004', name: '草地音乐节', attribute: 'd' },
];

