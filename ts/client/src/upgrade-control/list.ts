class LinkedListNode<T> {
    public readonly value;
    public readonly prev: LinkedListNode<T> | null = null;
    public readonly length: number;

    public constructor(value: T, prev: LinkedListNode<T> | null) {
        this.value = value;
        this.prev = prev;
        this.length = prev ? prev.length + 1 : 1;
    }
}

export class List<T> {
    private tail;

    public static fromArray<T>(data: T[] = []) {
        new List(data.reduceRight((acc: LinkedListNode<T> | null, value) => new LinkedListNode(value, acc), null));
    }

    public constructor(tail: LinkedListNode<T> | null = null) {
        this.tail = tail;
    }

    public push(value: T) {
        return new List(new LinkedListNode(value, this.tail));
    }

    public pop(): [T, List<T>] {
        if (this.tail === null) {
            throw new Error("List is empty");
        }

        const value = this.tail.value;
        const newTail = this.tail.prev;

        return [value, new List(newTail)];
    }

    public get length() {
        return this.tail?.length ?? 0;
    }

    public toArray(): T[] {
        const values: T[] = [];
        let current: LinkedListNode<T> | null = this.tail;

        while (current) {
            values.push(current.value);
            current = current.prev;
        }

        values.reverse();
        return values;
    }

    public [Symbol.iterator](): IterableIterator<T> {
        return this.toArray()[Symbol.iterator]();
    }
}
