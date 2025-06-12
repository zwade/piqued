/**
 * render-buffer.ts is code taken from a closed-source project.
 * In including it here, the author agrees to release it under the MIT license.
 * The original copyright is owned by Zachary Wade and may be used in accordance
 * with the MIT license.
 */

import chalk, { Chalk } from "chalk";

export interface Point {
    x: number;
    y: number;
}

export interface AnsiStyles {
    color?: string;
    bgColor?: string;
    strikethrough?: boolean;
    underline?: boolean;
    bold?: boolean;
}

export interface SegmentOptions extends AnsiStyles {
    characterWidth?: number;
}

const render = (styles: AnsiStyles, data: string) => {
    let c: Chalk = chalk;

    if (styles.color) {
        if (styles.color in chalk) {
            c = (c as any)[styles.color];
        } else {
            c = c.hex(styles.color);
        }
    }

    if (styles.bgColor) {
        const asBgName = `bg${styles.bgColor[0].toUpperCase()}${styles.bgColor.slice(1)}`;

        if (asBgName in chalk) {
            c = (c as any)[asBgName];
        } else {
            c = c.bgHex(styles.bgColor);
        }
    }

    if (styles.strikethrough) {
        c = c.strikethrough;
    }

    if (styles.underline) {
        c = c.underline;
    }

    if (styles.bold) {
        c = c.bold;
    }

    return c(data);
};

export class Segment {
    public width;
    public characterWidth: number;

    private data: string;
    private options: SegmentOptions;

    public static fromAscii(data: string, options: SegmentOptions = {}) {
        return new Segment(1, data, options);
    }

    constructor(width: number, data: string, options: SegmentOptions = {}) {
        if (width > 2) {
            console.warn("Width must be 1 or 2");
        }

        this.width = width;
        this.data = data;
        this.characterWidth = options.characterWidth ?? 1;
        this.options = options;
    }

    public get size() {
        return this.length * this.width;
    }

    public get length() {
        return this.data.length / this.characterWidth;
    }

    public dropPrefix(size: number) {
        const toDrop = Math.ceil(size / this.width);
        const extra = size % this.width;

        if (toDrop >= this.size) {
            const dropped = this.size;
            this.data = "";
            return dropped;
        }

        this.data = this.data.slice(toDrop * this.characterWidth);
        return size + extra;
    }

    public toSplit(index: number) {
        const start = Math.floor(index / this.width);

        return [
            new Segment(this.width, this.data.slice(0, start), this.options),
            new Segment(this.width, this.data.slice(start), this.options),
        ];
    }

    public toString() {
        return render(this.options, this.data);
    }
}

export interface RleBufferOptions extends SegmentOptions {
    empty?: string;
}

export class RleBuffer {
    public length;

    private segments: Segment[];
    private empty?: string;
    private options: RleBufferOptions;

    #prefixDirty = true;
    #prefixSums!: number[];

    public static fromSegments(segments: Segment[], options: RleBufferOptions = {}) {
        const length = segments.reduce((acc, seg) => acc + seg.size, 0);

        return new RleBuffer(length, segments, options);
    }

    public constructor(length: number, segments?: Segment[], options: RleBufferOptions = {}) {
        this.length = length;
        this.empty = options.empty?.[0] ?? " ";
        this.options = options;
        this.segments = segments ?? [this.getEmpty(length)];
    }

    private get prefixSums() {
        if (!this.#prefixDirty) {
            return this.#prefixSums;
        }

        this.#prefixSums = this.segments.reduce<[number[], number]>(
            ([val, acc], segment) => [[...val, acc + segment.size], acc + segment.size],
            [[0], 0],
        )[0];
        this.#prefixDirty = false;

        return this.#prefixSums;
    }

    private getEmpty(length: number) {
        return new Segment(1, Buffer.alloc(length, this.empty).toString("utf-8"), this.options);
    }

    private _write(index: number, data: Segment) {
        let s = data.size;
        let i = index;

        let startDropped = 0;

        while (true) {
            const segmentIndex = this.prefixSums.findIndex((sum) => sum >= i);
            if (i === this.prefixSums[segmentIndex]) {
                const segment = this.segments[segmentIndex];
                if (!segment) {
                    break;
                }

                if (segment.size === 0) {
                    this.segments.splice(segmentIndex, 1);
                    continue;
                }

                const dropped = segment.dropPrefix(s);
                if (segment.size === 0) {
                    this.segments.splice(segmentIndex, 1);
                }

                s -= dropped;
                if (dropped === 0) {
                    throw new Error("No progress!");
                }

                this.#prefixDirty = true;
            } else {
                const segment = this.segments[segmentIndex - 1];
                if (!segment) {
                    break;
                }

                const localIndex = i - this.prefixSums[segmentIndex - 1];
                if (localIndex % segment.width !== 0) {
                    i -= 1;
                    s += 1;
                    startDropped += 1;

                    continue;
                }

                const [newStart, newEnd] = segment.toSplit(localIndex);
                this.segments.splice(segmentIndex - 1, 1, newStart, newEnd);

                if (newStart.size === 0 || newEnd.size === 0) {
                    throw new Error("No progress!");
                }

                this.#prefixDirty = true;
            }

            if (s <= 0) {
                if (s < 0) {
                    this.segments.splice(segmentIndex, 0, this.getEmpty(-s));
                }

                this.segments.splice(segmentIndex, 0, data);

                if (startDropped) {
                    this.segments.splice(segmentIndex, 0, this.getEmpty(startDropped));
                }

                this.#prefixDirty = true;
                return;
            }
        }
    }

    public write(index: number, data: Segment) {
        this._write(index, data);

        if (this.prefixSums.slice(-1)[0] !== this.length) {
            throw new Error("Something went wrong with rle buffer");
        }
    }

    public copyIn(index: number, other: RleBuffer) {
        let runningIndex = index;
        for (let i = 0; i < other.segments.length; i++) {
            if (runningIndex + other.segments[i].size > this.length) {
                break;
            }

            this.write(runningIndex, other.segments[i]);
            runningIndex += other.segments[i].size;
        }
    }

    public extendLength(toAdd: number) {
        this.segments.push(this.getEmpty(toAdd));
        this.length += toAdd;
        this.#prefixDirty = true;
    }

    public clear() {
        this.segments = [this.getEmpty(this.length)];
        this.#prefixDirty = true;
    }

    public toString() {
        return this.segments.map((s) => s.toString()).join("");
    }
}

export interface RleMatrixOptions extends SegmentOptions {
    empty?: string;
}

export interface RleMatrixFromAsciiOptions extends RleMatrixOptions {
    width?: number;
}

export class RleMatrix {
    public width;
    public height;

    private data: RleBuffer[];
    private options;

    public static fromAscii(data: string, options: RleMatrixFromAsciiOptions = {}) {
        const width = options.width ?? data.length;

        const asArray = Array.from(new Array(data.length / width), (_, y) => [data.slice(y * width, (y + 1) * width)]);
        return RleMatrix.fromArray(asArray, options);
    }

    public static fromArray(data: (string | Segment)[][], options: RleMatrixOptions = {}) {
        const asSegments = data.map((row) =>
            row.map((el) => (el instanceof Segment ? el : Segment.fromAscii(el, options))),
        );
        const buffers = asSegments.map((row) => RleBuffer.fromSegments(row, options));

        return new RleMatrix(buffers[0].length, buffers.length, buffers, options);
    }

    public constructor(width: number, height: number, data?: RleBuffer[], options: RleMatrixOptions = {}) {
        this.width = width;
        this.height = height;
        this.options = options;

        this.data = data ?? Array.from(new Array(height), () => new RleBuffer(width, undefined, options));
    }

    public clear() {
        for (const buff of this.data) {
            buff.clear();
        }
    }

    public copyIn(start: Point, other: RleMatrix) {
        if (start.y + other.height > this.height) {
            this.extendHeight(start.y + other.height - this.data.length);
        }

        if (start.x + other.width > this.width) {
            this.extendWidth(start.x + other.width - this.width);
        }

        for (let i = 0; i < other.height; i++) {
            if (start.y + i >= this.data.length) {
                break;
            }

            this.data[start.y + i].copyIn(start.x, other.data[i]);
        }
    }

    public extendHeight(toAdd: number) {
        const newHeight = this.height + toAdd;

        for (let i = 0; i < toAdd; i++) {
            this.data.push(new RleBuffer(this.width, undefined, this.options));
        }

        this.height = newHeight;
    }

    public extendWidth(toAdd: number) {
        for (const buff of this.data) {
            buff.extendLength(toAdd);
        }

        this.width += toAdd;
    }

    public setAscii(start: Point, data: string, options: RleMatrixFromAsciiOptions = {}) {
        const mergedOptions: RleMatrixFromAsciiOptions = {
            characterWidth: options.characterWidth,
            color: options.color ?? this.options.color,
            bgColor: options.bgColor ?? this.options.bgColor,
            empty: options.empty ?? this.options.empty,
        };

        const matrix = RleMatrix.fromAscii(data, mergedOptions);
        this.copyIn(start, matrix);
    }

    public getRow(i: number) {
        return this.data[i];
    }

    public [Symbol.iterator]() {
        return this.data[Symbol.iterator]();
    }
}
