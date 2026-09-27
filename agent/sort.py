"""常用排序算法实现（Python）

包含：快速排序、归并排序、冒泡排序、插入排序
所有函数均返回新的已排序列表，不修改入参。
"""

from typing import List


def quick_sort(arr: List[int]) -> List[int]:
    """快速排序：分治法，平均时间复杂度 O(n log n)。"""
    if len(arr) <= 1:
        return list(arr)
    pivot = arr[len(arr) // 2]
    left = [x for x in arr if x < pivot]
    middle = [x for x in arr if x == pivot]
    right = [x for x in arr if x > pivot]
    return quick_sort(left) + middle + quick_sort(right)


def merge_sort(arr: List[int]) -> List[int]:
    """归并排序：稳定排序，时间复杂度 O(n log n)。"""
    if len(arr) <= 1:
        return list(arr)
    mid = len(arr) // 2
    left = merge_sort(arr[:mid])
    right = merge_sort(arr[mid:])
    return _merge(left, right)


def _merge(left: List[int], right: List[int]) -> List[int]:
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


def bubble_sort(arr: List[int]) -> List[int]:
    """冒泡排序：时间复杂度 O(n^2)，仅用于教学演示。"""
    data = list(arr)
    n = len(data)
    for i in range(n - 1):
        swapped = False
        for j in range(n - 1 - i):
            if data[j] > data[j + 1]:
                data[j], data[j + 1] = data[j + 1], data[j]
                swapped = True
        if not swapped:
            break
    return data


def insertion_sort(arr: List[int]) -> List[int]:
    """插入排序：小规模数据表现良好，时间复杂度 O(n^2)。"""
    data = list(arr)
    for i in range(1, len(data)):
        key = data[i]
        j = i - 1
        while j >= 0 and data[j] > key:
            data[j + 1] = data[j]
            j -= 1
        data[j + 1] = key
    return data


def is_sorted(arr: List[int]) -> bool:
    """校验列表是否为非递减有序。"""
    return all(arr[i] <= arr[i + 1] for i in range(len(arr) - 1))


if __name__ == "__main__":
    sample = [5, 2, 9, 1, 5, 6, -3, 0, 12, 7]

    algorithms = {
        "quick_sort": quick_sort,
        "merge_sort": merge_sort,
        "bubble_sort": bubble_sort,
        "insertion_sort": insertion_sort,
    }

    print(f"原始数组: {sample}")
    for name, func in algorithms.items():
        result = func(sample)
        assert is_sorted(result), f"{name} 结果未排序"
        print(f"{name:<16} -> {result}")

    print(f"原始数组未被修改: {sample}")