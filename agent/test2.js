// ==========================================
// agent/test.js
// 测试 parseAgentOutput 的各种边界场景
// 运行: node test.js
// ==========================================
import { extractContentBlock,parseAgentOutput } from "./agent.js";

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



  // 1. 提取 CONTENT 块
const { rawContent, cleanedText } = extractContentBlock(REAL_LLM_OUTPUT);

console.log("rawContent=",rawContent)
console.log("cleanedText=",cleanedText)

