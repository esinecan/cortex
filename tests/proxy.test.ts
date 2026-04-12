import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { jsonSchemaToZodShape } from '../src/proxy.js';

describe('Proxy: JSON Schema to Zod conversion', () => {
  it('converts string properties', () => {
    const shape = jsonSchemaToZodShape({
      properties: { name: { type: 'string', description: 'A name' } },
      required: ['name'],
    });
    expect(shape.name).toBeDefined();
    const result = shape.name.safeParse('hello');
    expect(result.success).toBe(true);
  });

  it('converts number properties', () => {
    const shape = jsonSchemaToZodShape({
      properties: { count: { type: 'number' } },
      required: ['count'],
    });
    const result = shape.count.safeParse(42);
    expect(result.success).toBe(true);
  });

  it('converts integer properties', () => {
    const shape = jsonSchemaToZodShape({
      properties: { count: { type: 'integer' } },
      required: ['count'],
    });
    const result = shape.count.safeParse(42);
    expect(result.success).toBe(true);
  });

  it('converts boolean properties', () => {
    const shape = jsonSchemaToZodShape({
      properties: { flag: { type: 'boolean' } },
      required: ['flag'],
    });
    const result = shape.flag.safeParse(true);
    expect(result.success).toBe(true);
  });

  it('converts array properties', () => {
    const shape = jsonSchemaToZodShape({
      properties: {
        items: {
          type: 'array',
          items: { type: 'string' },
        },
      },
      required: ['items'],
    });
    const result = shape.items.safeParse(['a', 'b']);
    expect(result.success).toBe(true);
  });

  it('converts object properties', () => {
    const shape = jsonSchemaToZodShape({
      properties: {
        data: { type: 'object' },
      },
      required: ['data'],
    });
    const result = shape.data.safeParse({ key: 'value' });
    expect(result.success).toBe(true);
  });

  it('converts enum properties', () => {
    const shape = jsonSchemaToZodShape({
      properties: {
        color: { enum: ['red', 'green', 'blue'] },
      },
      required: ['color'],
    });
    const valid = shape.color.safeParse('red');
    expect(valid.success).toBe(true);
    const invalid = shape.color.safeParse('yellow');
    expect(invalid.success).toBe(false);
  });

  it('marks optional properties correctly', () => {
    const shape = jsonSchemaToZodShape({
      properties: {
        required_field: { type: 'string' },
        optional_field: { type: 'string' },
      },
      required: ['required_field'],
    });
    // Optional field should accept undefined
    const result = shape.optional_field.safeParse(undefined);
    expect(result.success).toBe(true);
  });

  it('handles empty schema', () => {
    const shape = jsonSchemaToZodShape({});
    expect(Object.keys(shape)).toHaveLength(0);
  });

  it('preprocess: coerces string numbers', () => {
    const shape = jsonSchemaToZodShape({
      properties: { count: { type: 'number' } },
      required: ['count'],
    });
    const result = shape.count.safeParse('42');
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe(42);
  });

  it('preprocess: coerces string booleans', () => {
    const shape = jsonSchemaToZodShape({
      properties: { flag: { type: 'boolean' } },
      required: ['flag'],
    });
    const result = shape.flag.safeParse('true');
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe(true);
  });

  it('preprocess: parses JSON string arrays', () => {
    const shape = jsonSchemaToZodShape({
      properties: {
        items: { type: 'array', items: { type: 'string' } },
      },
      required: ['items'],
    });
    const result = shape.items.safeParse('["a","b"]');
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual(['a', 'b']);
  });

  it('preserves descriptions', () => {
    const shape = jsonSchemaToZodShape({
      properties: {
        name: { type: 'string', description: 'The name' },
      },
      required: ['name'],
    });
    expect(shape.name.description).toBe('The name');
  });

  it('falls back to z.any() for unknown types', () => {
    const shape = jsonSchemaToZodShape({
      properties: {
        mystery: { type: 'unknown_type' },
      },
      required: ['mystery'],
    });
    const result = shape.mystery.safeParse('anything');
    expect(result.success).toBe(true);
  });
});
