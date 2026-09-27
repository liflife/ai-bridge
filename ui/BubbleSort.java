import java.util.Arrays;

public class BubbleSort {

    public static void bubbleSort(int[] arr) {
        if (arr == null || arr.length < 2) {
            return;
        }
        int n = arr.length;
        for (int i = 0; i < n - 1; i++) {
            boolean swapped = false;
            for (int j = 0; j < n - 1 - i; j++) {
                if (arr[j] > arr[j + 1]) {
                    int tmp = arr[j];
                    arr[j] = arr[j + 1];
                    arr[j + 1] = tmp;
                    swapped = true;
                }
            }
            if (!swapped) {
                break;
            }
        }
    }

    public static void main(String[] args) {
        int[] arr = {5, 2, 9, 1, 5, 6, 3, 8, 7, 4};
        System.out.println("Before: " + Arrays.toString(arr));
        bubbleSort(arr);
        System.out.println("After:  " + Arrays.toString(arr));
    }
}