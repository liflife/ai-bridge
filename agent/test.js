// ==========================================
// agent/test.js
// 测试 parseAgentOutput 的各种边界场景
// 运行: node test.js
// ==========================================
import { parseAgentOutput } from "./agent.js";

// ==========================================
// 测试框架
// ==========================================
let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`✅ ${name}`);
  } catch (err) {
    failed++;
    console.error(`❌ ${name}`);
    console.error(`   ${err.message}`);
  }
}

function assertEqual(actual, expected, label = "") {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${label}\n  期望: ${e}\n  实际: ${a}`);
  }
}

function assertTruthy(value, label = "") {
  if (!value) throw new Error(`${label} 应该为真, 实际: ${value}`);
}

function assertIncludes(haystack, needle, label = "") {
  if (typeof haystack !== "string" || !haystack.includes(needle)) {
    throw new Error(`${label}\n  未找到: ${JSON.stringify(needle)}\n  在字符串(前200字): ${JSON.stringify(String(haystack).slice(0, 200))}`);
  }
}

// ==========================================
// 场景 1: 纯 JSON
// ==========================================
console.log("\n--- 场景 1: 纯 JSON ---");

test("纯 JSON - final_answer", () => {
  const input = `{"thought":"完成","final_answer":"你好"}`;
  const r = parseAgentOutput(input);
  assertEqual(r.thought, "完成", "thought");
  assertEqual(r.final_answer, "你好", "final_answer");
});

test("纯 JSON - read_file", () => {
  const input = `{"thought":"读文件","action":"read_file","action_input":{"path":"a.txt"}}`;
  const r = parseAgentOutput(input);
  assertEqual(r.action, "read_file", "action");
  assertEqual(r.action_input.path, "a.txt", "path");
});

// ==========================================
// 场景 2: 带思考前缀
// ==========================================
console.log("\n--- 场景 2: 带思考前缀 ---");

test("思考文本 + JSON", () => {
  const input = `我需要先读文件。然后分析。
{"thought":"读文件","action":"read_file","action_input":{"path":"a.txt"}}`;
  const r = parseAgentOutput(input);
  assertEqual(r.action, "read_file", "action");
});

test("思考文本里也有 JSON 花括号干扰", () => {
  const input = `我想了想 {"foo":"bar"} 这个结构。
真正的输出是：
{"thought":"读文件","action":"read_file","action_input":{"path":"a.txt"}}`;
  const r = parseAgentOutput(input);
  assertEqual(r.action, "read_file", "action");
  assertEqual(r.action_input.path, "a.txt", "path");
});

// ==========================================
// 场景 3: markdown 代码块
// ==========================================
console.log("\n--- 场景 3: markdown 代码块 ---");

test("json 代码块", () => {
  const input = "```json\n{\"thought\":\"完成\",\"final_answer\":\"ok\"}\n```";
  const r = parseAgentOutput(input);
  assertEqual(r.final_answer, "ok", "final_answer");
});

test("无语言标记的代码块", () => {
  const input = "```\n{\"thought\":\"完成\",\"final_answer\":\"ok\"}\n```";
  const r = parseAgentOutput(input);
  assertEqual(r.final_answer, "ok", "final_answer");
});

// ==========================================
// 场景 4: <<<CONTENT>>> 内容块
// ==========================================
console.log("\n--- 场景 4: CONTENT 内容块 ---");

test("write_file + CONTENT 块", () => {
  const input = `{"thought":"写文件","action":"write_file","action_input":{"path":"hello.py"}}
<<<CONTENT>>>
def hello():
    print("Hello")
<<<END_CONTENT>>>`;
  const r = parseAgentOutput(input);
  assertEqual(r.action, "write_file", "action");
  assertEqual(r.action_input.path, "hello.py", "path");
  assertEqual(r.action_input.content, 'def hello():\n    print("Hello")', "content");
});

test("CONTENT 块内有双引号、单引号、换行、中文", () => {
  const input = `{"thought":"写文件","action":"write_file","action_input":{"path":"test.txt"}}
<<<CONTENT>>>
他说： "你好"
她说： 'Hello'
中文、emoji 😀、tab\t等
<<<END_CONTENT>>>`;
  const r = parseAgentOutput(input);
  if (!r.action_input.content.includes('"你好"')) {
    throw new Error("双引号丢失");
  }
  if (!r.action_input.content.includes("'Hello'")) {
    throw new Error("单引号丢失");
  }
  if (!r.action_input.content.includes("😀")) {
    throw new Error("emoji 丢失");
  }
});

test("CONTENT 块前后有换行时正确去除", () => {
  const input = `{"thought":"x","action":"write_file","action_input":{"path":"a.txt"}}
<<<CONTENT>>>

line1
line2

<<<END_CONTENT>>>`;
  const r = parseAgentOutput(input);
  assertEqual(r.action_input.content, "line1\nline2", "content");
});

test("CONTENT 块在 JSON 之前（位置无关）", () => {
  const input = `<<<CONTENT>>>
原始内容
<<<END_CONTENT>>>
{"thought":"x","action":"write_file","action_input":{"path":"a.txt"}}`;
  const r = parseAgentOutput(input);
  assertEqual(r.action_input.content, "原始内容", "content");
  assertEqual(r.action_input.path, "a.txt", "path");
});

test("没有 CONTENT 块的 write_file 不填充 content", () => {
  const input = `{"thought":"x","action":"write_file","action_input":{"path":"a.txt"}}`;
  const r = parseAgentOutput(input);
  assertEqual(r.action, "write_file", "action");
  assertEqual(r.action_input.content, undefined, "content 应该是 undefined");
});

// ==========================================
// 场景 5: 转义修复
// ==========================================
console.log("\n--- 场景 5: 转义修复 ---");

test("Windows 路径的非法转义被修复", () => {
  const input = `{"thought":"x","action":"read_file","action_input":{"path":"F:\\project\\a.txt"}}`;
  const r = parseAgentOutput(input);
  assertEqual(r.action_input.path, "F:\\project\\a.txt", "path");
});

// ==========================================
// 场景 6: 综合场景
// ==========================================
console.log("\n--- 场景 6: 综合场景 ---");

test("思考 + 代码块 JSON + CONTENT 块", () => {
  const input = `让我先分析一下任务。用户想要一个快速排序。
我决定使用 write_file 工具。

\`\`\`json
{"thought":"写快速排序","action":"write_file","action_input":{"path":"sort.py"}}
\`\`\`

<<<CONTENT>>>
def quick_sort(arr):
    if len(arr) <= 1:
        return arr
    pivot = arr[0]
    return quick_sort([x for x in arr[1:] if x < pivot]) + [pivot] + quick_sort([x for x in arr[1:] if x >= pivot])
<<<END_CONTENT>>>`;
  const r = parseAgentOutput(input);
  assertEqual(r.action, "write_file", "action");
  assertEqual(r.action_input.path, "sort.py", "path");
  assertIncludes(r.action_input.content, "def quick_sort", "content");
});

// ==========================================
// 场景 7: 失败场景
// ==========================================
console.log("\n--- 场景 7: 失败场景（应该返回 null） ---");

test("完全不是 JSON", () => {
  const input = "你好，我是 AI";
  const r = parseAgentOutput(input);
  assertEqual(r, null, "应该返回 null");
});

test("空字符串", () => {
  const r = parseAgentOutput("");
  assertEqual(r, null, "应该返回 null");
});

test("null 输入", () => {
  const r = parseAgentOutput(null);
  assertEqual(r, null, "应该返回 null");
});

test("JSON 非法且无法修复", () => {
  const input = `{"thought": 未闭合的字符串}`;
  const r = parseAgentOutput(input);
  if (r !== null && r.action !== undefined && r.final_answer !== undefined) {
    throw new Error("非法 JSON 被错误解析");
  }
});

// ==========================================
// 场景 8: 真实 LLM 输出回归测试
// ==========================================
console.log("\n--- 场景 8: 真实 LLM 输出回归测试 ---");

const REAL_LLM_OUTPUT = `{"thought":"生成一个包含快速排序和归并排序的 Python 文件","action":"write_file","action_input":{"path":"sort_algorithm.py"}}
<<<CONTENT>>>
# 排序算法集合
# 包含快速排序和归并排序

def quick_sort(arr):
    """快速排序，返回新的有序列表"""
    if len(arr) <= 1:
        return arr
    pivot = arr[len(arr) // 2]
    left = [x for x in arr if x < pivot]
    middle = [x for x in arr if x == pivot]
    right = [x for x in arr if x > pivot]
    return quick_sort(left) + middle + quick_sort(right)


def merge_sort(arr):
    """归并排序，返回新的有序列表"""
    if len(arr) <= 1:
        return arr
    mid = len(arr) // 2
    left = merge_sort(arr[:mid])
    right = merge_sort(arr[mid:])
    return merge(left, right)


def merge(left, right):
    """合并两个有序列表"""
    result = []
    i = j = 0
    while i < len(left) and j < len(right):
        if left[i] <= right[j]:
            result.append(left[i])
            i += 1
        else:
            result.append(right[j])
            j += 1
    result.extend(left[i:])
    result.extend(right[j:])
    return result


def bubble_sort(arr):
    """冒泡排序，原地排序"""
    n = len(arr)
    for i in range(n):
        swapped = False
        for j in range(0, n - i - 1):
            if arr[j] > arr[j + 1]:
                arr[j], arr[j + 1] = arr[j + 1], arr[j]
                swapped = True
        if not swapped:
            break
    return arr


if __name__ == '__main__':
    test_data = [64, 34, 25, 12, 22, 11, 90]
    print("原始数据:", test_data)
    print("快速排序:", quick_sort(test_data))
    print("归并排序:", merge_sort(test_data))
    print("冒泡排序:", bubble_sort(test_data.copy()))
<<<END_CONTENT>>>`;

// 这里手写"期望的 content"，它应该等于 CONTENT 标记之间、去掉首尾换行后的原文
const EXPECTED_CONTENT = `# 排序算法集合
# 包含快速排序和归并排序

def quick_sort(arr):
    """快速排序，返回新的有序列表"""
    if len(arr) <= 1:
        return arr
    pivot = arr[len(arr) // 2]
    left = [x for x in arr if x < pivot]
    middle = [x for x in arr if x == pivot]
    right = [x for x in arr if x > pivot]
    return quick_sort(left) + middle + quick_sort(right)


def merge_sort(arr):
    """归并排序，返回新的有序列表"""
    if len(arr) <= 1:
        return arr
    mid = len(arr) // 2
    left = merge_sort(arr[:mid])
    right = merge_sort(arr[mid:])
    return merge(left, right)


def merge(left, right):
    """合并两个有序列表"""
    result = []
    i = j = 0
    while i < len(left) and j < len(right):
        if left[i] <= right[j]:
            result.append(left[i])
            i += 1
        else:
            result.append(right[j])
            j += 1
    result.extend(left[i:])
    result.extend(right[j:])
    return result


def bubble_sort(arr):
    """冒泡排序，原地排序"""
    n = len(arr)
    for i in range(n):
        swapped = False
        for j in range(0, n - i - 1):
            if arr[j] > arr[j + 1]:
                arr[j], arr[j + 1] = arr[j + 1], arr[j]
                swapped = True
        if not swapped:
            break
    return arr


if __name__ == '__main__':
    test_data = [64, 34, 25, 12, 22, 11, 90]
    print("原始数据:", test_data)
    print("快速排序:", quick_sort(test_data))
    print("归并排序:", merge_sort(test_data))
    print("冒泡排序:", bubble_sort(test_data.copy()))`;

test("真实 LLM 输出: 基础字段正确", () => {
  const r = parseAgentOutput(REAL_LLM_OUTPUT);
  assertTruthy(r, "解析结果不应为空");
  assertEqual(r.action, "write_file", "action");
  assertEqual(r.action_input.path, "sort_algorithm.py", "path");
});

test("真实 LLM 输出: content 与原文逐字一致", () => {
  const r = parseAgentOutput(REAL_LLM_OUTPUT);
  assertEqual(r.action_input.content, EXPECTED_CONTENT, "content 内容不匹配");
});

test("真实 LLM 输出: content 长度正确", () => {
  const r = parseAgentOutput(REAL_LLM_OUTPUT);
  assertEqual(r.action_input.content.length, EXPECTED_CONTENT.length, "content 长度");
});

test("真实 LLM 输出: 首行是注释", () => {
  const r = parseAgentOutput(REAL_LLM_OUTPUT);
  const firstLine = r.action_input.content.split("\n")[0];
  assertEqual(firstLine, "# 排序算法集合", "首行");
});

test("真实 LLM 输出: 尾行是 print 调用", () => {
  const r = parseAgentOutput(REAL_LLM_OUTPUT);
  const lines = r.action_input.content.split("\n");
  const lastLine = lines[lines.length - 1];
  assertEqual(lastLine, '    print("冒泡排序:", bubble_sort(test_data.copy()))', "尾行");
});

test("真实 LLM 输出: content 含关键函数定义", () => {
  const r = parseAgentOutput(REAL_LLM_OUTPUT);
  const c = r.action_input.content;
  assertIncludes(c, "def quick_sort(arr):", "quick_sort 定义");
  assertIncludes(c, "def merge_sort(arr):", "merge_sort 定义");
  assertIncludes(c, "def merge(left, right):", "merge 定义");
  assertIncludes(c, "def bubble_sort(arr):", "bubble_sort 定义");
  assertIncludes(c, "if __name__ == '__main__':", "__main__ 保护");
});

test("真实 LLM 输出: content 保留三引号 docstring", () => {
  const r = parseAgentOutput(REAL_LLM_OUTPUT);
  const c = r.action_input.content;
  assertIncludes(c, '"""快速排序，返回新的有序列表"""', "docstring 1");
  assertIncludes(c, '"""归并排序，返回新的有序列表"""', "docstring 2");
  assertIncludes(c, '"""冒泡排序，原地排序"""', "docstring 4");
});

test("真实 LLM 输出: content 保留双引号和单引号混合", () => {
  const r = parseAgentOutput(REAL_LLM_OUTPUT);
  const c = r.action_input.content;
  // 单引号（__main__ 判断）
  assertIncludes(c, "'__main__'", "单引号");
  // 双引号（print 参数）
  assertIncludes(c, 'print("原始数据:", test_data)', "双引号");
});

test("真实 LLM 输出: content 保留中文注释", () => {
  const r = parseAgentOutput(REAL_LLM_OUTPUT);
  const c = r.action_input.content;
  assertIncludes(c, "排序算法集合", "中文注释1");
  assertIncludes(c, "包含快速排序和归并排序", "中文注释2");
  assertIncludes(c, "原始数据", "中文 print");
});

test("真实 LLM 输出: content 保留空行结构", () => {
  const r = parseAgentOutput(REAL_LLM_OUTPUT);
  const c = r.action_input.content;
  // 函数之间有两个空行（PEP8 风格）
  assertIncludes(c, "return quick_sort(left) + middle + quick_sort(right)\n\n\ndef merge_sort", "函数间空行");
});

test("真实 LLM 输出: content 不含 CONTENT 标记", () => {
  const r = parseAgentOutput(REAL_LLM_OUTPUT);
  const c = r.action_input.content;
  if (c.includes("<<<CONTENT>>>") || c.includes("<<<END_CONTENT>>>")) {
    throw new Error("content 中不应该包含 CONTENT 标记");
  }
});

test("真实 LLM 输出: content 首尾没有多余换行", () => {
  const r = parseAgentOutput(REAL_LLM_OUTPUT);
  const c = r.action_input.content;
  if (c.startsWith("\n")) throw new Error("content 以换行开头");
  if (c.endsWith("\n")) throw new Error("content 以换行结尾");
});

test("真实 LLM 输出: 不包含 JSON 部分的任何残留", () => {
  const r = parseAgentOutput(REAL_LLM_OUTPUT);
  const c = r.action_input.content;
  if (c.includes("thought")) throw new Error("content 含 'thought'");
  if (c.includes("action_input")) throw new Error("content 含 'action_input'");
});

// ==========================================
// 结果
// ==========================================
console.log("\n=============================");
console.log(`通过: ${passed}`);
console.log(`失败: ${failed}`);
console.log("=============================");

process.exit(failed > 0 ? 1 : 0);