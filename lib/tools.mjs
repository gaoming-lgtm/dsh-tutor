// Tool definitions + schemas for the tutoring agent.
export const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: '列出教学项目目录下的文件。用于了解学生项目结构。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对教学项目根目录的路径，默认 "."' },
          depth: { type: 'integer', description: '递归深度，1-3，默认 2' },
        },
      },
    },
    meta: { risk: 'low', label: '查看目录' },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: '读取教学项目里的一个文本文件，返回带行号的内容。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对教学项目根目录的文件路径' },
          start_line: { type: 'integer', description: '起始行（从 1 开始），可选' },
          end_line: { type: 'integer', description: '结束行，可选' },
        },
        required: ['path'],
      },
    },
    meta: { risk: 'low', label: '读取文件' },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: '把内容写入教学项目里的文件（会覆盖整个文件）。只在学生同意、并且你已读原文件时使用。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对教学项目根目录的文件路径' },
          content: { type: 'string', description: '要写入的完整文件内容' },
          reason: { type: 'string', description: '一句话说明为什么写入、改了什么' },
        },
        required: ['path', 'content', 'reason'],
      },
    },
    meta: { risk: 'medium', label: '写入文件' },
  },
  {
    type: 'function',
    function: {
      name: 'replace_in_file',
      description: '把文件里的一段原文替换成新内容，适合只改几行。old_string 必须与原文完全一致。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对教学项目根目录的文件路径' },
          old_string: { type: 'string', description: '要被替换的原文（需唯一）' },
          new_string: { type: 'string', description: '替换后的内容' },
          reason: { type: 'string', description: '一句话说明为什么改' },
        },
        required: ['path', 'old_string', 'new_string', 'reason'],
      },
    },
    meta: { risk: 'medium', label: '修改代码' },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: '在教学项目目录里执行一条命令（PowerShell）。用于运行学生代码、看报错、装依赖。长命令请谨慎。',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的命令' },
          cwd: { type: 'string', description: '工作目录（相对教学项目根目录），默认 "."' },
          timeout_sec: { type: 'integer', description: '超时秒数，默认 60，最大 180' },
        },
        required: ['command'],
      },
    },
    meta: { risk: 'high', label: '执行命令' },
  },
  {
    type: 'function',
    function: {
      name: 'show_board',
      description: '把一段代码/示意图放到黑板右侧展示，不写入学生文件。讲概念、做示范时用这个。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '黑板标题，例如 "循环的边界" 或 "本课目标"' },
          language: { type: 'string', description: '语言，例如 python / javascript / text' },
          code: { type: 'string', description: '要展示的代码或文本' },
          note: { type: 'string', description: '一句注解，可选' },
          points: {
            type: 'array',
            description: '要写在黑板上的要点，2-5 条，每条一句话。讲规则、注意点、本课目标时用。',
            items: { type: 'string' },
          },
        },
        required: ['title', 'code'],
      },
    },
    meta: { risk: 'low', label: '上黑板' },
  },
  {
    type: 'function',
    function: {
      name: 'set_plan',
      description: '把这次任务的步骤列到计划板，让学生知道走到哪一步。最多 5 步。',
      parameters: {
        type: 'object',
        properties: {
          steps: {
            type: 'array',
            description: '步骤列表',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                status: { type: 'string', enum: ['todo', 'in_progress', 'done'] },
              },
              required: ['title', 'status'],
            },
          },
        },
        required: ['steps'],
      },
    },
    meta: { risk: 'low', label: '更新计划' },
  },
  {
    type: 'function',
    function: {
      name: 'look_at_screen',
      description: '截取学生当前的整个屏幕，并做本地文字识别（OCR）。用来看学生正在看什么窗口、代码哪里报错。每次调用都会先问学生。',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: '一句话说明为什么要看屏幕' },
        },
      },
    },
    meta: { risk: 'medium', label: '看屏幕' },
  },
  {
    type: 'function',
    function: {
      name: 'ide_context',
      description: '查学生电脑上的编辑器情况：PyCharm 装在哪、是否开着、最近打开的是哪个项目、当前正在编辑哪个文件。',
      parameters: { type: 'object', properties: {} },
    },
    meta: { risk: 'low', label: '查看编辑器' },
  },
  {
    type: 'function',
    function: {
      name: 'open_in_editor',
      description: '在学生的 IDE（PyCharm / VS Code）里打开某个文件，并跳到指定行。用于"看这里"。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对教学项目根目录的文件路径' },
          line: { type: 'integer', description: '行号，可选' },
        },
        required: ['path'],
      },
    },
    meta: { risk: 'medium', label: '打开编辑器' },
  },
];

export const TOOL_MAP = new Map(TOOLS.map((t) => [t.function.name, t]));
