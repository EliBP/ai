import {
  EventSourceParserStream,
  ParsedEvent,
} from 'eventsource-parser/stream';
import { ZodSchema } from 'zod';
import { ApiCallError } from '../errors';
import { parseJSON, safeParseJSON } from './parse-json';
import { ParsedChunk } from './parsed-chunk';

export type ResponseHandler<RETURN_TYPE> = (options: {
  url: string;
  requestBodyValues: unknown;
  response: Response;
}) => PromiseLike<RETURN_TYPE>;

export const createJsonErrorResponseHandler =
  <T>({
    errorSchema,
    errorToMessage,
    isRetryable,
  }: {
    errorSchema: ZodSchema<T>;
    errorToMessage: (error: T) => string;
    isRetryable?: (response: Response, error?: T) => boolean;
  }): ResponseHandler<ApiCallError> =>
  async ({ response, url, requestBodyValues }) => {
    const responseBody = await response.text();

    // Some providers return an empty response body for some errors:
    if (responseBody.trim() === '') {
      return new ApiCallError({
        message: response.statusText,
        url,
        requestBodyValues,
        statusCode: response.status,
        responseBody,
        isRetryable: isRetryable?.(response),
      });
    }

    // resilient parsing in case the response is not JSON or does not match the schema:
    try {
      const parsedError = parseJSON({
        text: responseBody,
        schema: errorSchema,
      });

      return new ApiCallError({
        message: errorToMessage(parsedError),
        url,
        requestBodyValues,
        statusCode: response.status,
        responseBody,
        data: parsedError,
        isRetryable: isRetryable?.(response, parsedError),
      });
    } catch (parseError) {
      return new ApiCallError({
        message: response.statusText,
        url,
        requestBodyValues,
        statusCode: response.status,
        responseBody,
        isRetryable: isRetryable?.(response),
      });
    }
  };

export const createEventSourceResponseHandler =
  <T>(
    chunkSchema: ZodSchema<T>,
  ): ResponseHandler<ReadableStream<ParsedChunk<T>>> =>
  async ({ response }: { response: Response }) => {
    if (response.body == null) {
      throw new Error('No response body'); // TODO AI error
    }

    return response.body
      .pipeThrough(new TextDecoderStream())
      .pipeThrough(new EventSourceParserStream())
      .pipeThrough(
        new TransformStream<ParsedEvent, ParsedChunk<T>>({
          transform({ data }, controller) {
            if (data === '[DONE]') {
              return;
            }

            const parseResult = safeParseJSON({
              text: data,
              schema: chunkSchema,
            });

            controller.enqueue(
              parseResult.success
                ? { type: 'value', value: parseResult.value }
                : { type: 'error', error: parseResult.error },
            );
          },
        }),
      );
  };

export const createJsonResponseHandler =
  <T>(responseSchema: ZodSchema<T>): ResponseHandler<T> =>
  async ({ response, url, requestBodyValues }) => {
    const responseBody = await response.text();

    const parsedResult = safeParseJSON({
      text: responseBody,
      schema: responseSchema,
    });

    if (!parsedResult.success) {
      throw new ApiCallError({
        message: 'Invalid JSON response',
        cause: parsedResult.error,
        statusCode: response.status,
        responseBody,
        url,
        requestBodyValues,
      });
    }

    return parsedResult.value;
  };
