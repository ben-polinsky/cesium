import defined from "../Core/defined.js";
import FeatureDetection from "../Core/FeatureDetection.js";
import RuntimeError from "../Core/RuntimeError.js";
import TaskProcessor from "../Core/TaskProcessor.js";

/**
 * @private
 */
class DracoLoader {
  static _getOrCreateDecoderTaskProcessor() {
    if (!defined(DracoLoader._decoderTaskProcessor)) {
      DracoLoader._decoderTaskProcessor = new TaskProcessor(
        "decodeDraco",
        DracoLoader._maxDecodingConcurrency,
      );
    }

    return DracoLoader._decoderTaskProcessor;
  }

  static _initializeDecoderTaskProcessor() {
    if (!defined(DracoLoader._taskProcessorReadyPromise)) {
      const processor = DracoLoader._getOrCreateDecoderTaskProcessor();
      DracoLoader._taskProcessorReadyPromise = processor
        .initWebAssemblyModule({
          wasmBinaryFile: "ThirdParty/draco_decoder.wasm",
        })
        .then(function (result) {
          if (result) {
            DracoLoader._taskProcessorReady = true;
          } else {
            DracoLoader._error = new RuntimeError(
              "Draco decoder could not be initialized.",
            );
          }
        })
        .catch((error) => {
          DracoLoader._error = error;
        });
    }

    return DracoLoader._taskProcessorReadyPromise;
  }

  static _getDecoderTaskProcessor() {
    const processor = DracoLoader._getOrCreateDecoderTaskProcessor();
    DracoLoader._initializeDecoderTaskProcessor();
    return processor;
  }

  static async _preloadWorkerForBenchmark() {
    return DracoLoader._getOrCreateDecoderTaskProcessor()._preloadWorker();
  }

  static async _preloadWorkerAndWasmForBenchmark() {
    const processor = DracoLoader._getOrCreateDecoderTaskProcessor();
    const canTransferArrayBuffer = await processor._preloadWorker();
    await DracoLoader._initializeDecoderTaskProcessor();
    if (defined(DracoLoader._error)) {
      throw DracoLoader._error;
    }
    return canTransferArrayBuffer;
  }

  /**
   * Decodes a compressed point cloud. Returns undefined if the task cannot be scheduled.
   * @private
   *
   * @exception {RuntimeError} Draco decoder could not be initialized.
   */
  static decodePointCloud(parameters) {
    const decoderTaskProcessor = DracoLoader._getDecoderTaskProcessor();
    if (defined(DracoLoader._error)) {
      throw DracoLoader._error;
    }

    if (!DracoLoader._taskProcessorReady) {
      // The task processor is not ready to schedule tasks
      return;
    }
    return decoderTaskProcessor.scheduleTask(parameters, [
      parameters.buffer.buffer,
    ]);
  }

  /**
   * Decodes a buffer view. Returns undefined if the task cannot be scheduled.
   *
   * @param {object} options Object with the following properties:
   * @param {Uint8Array} options.array The typed array containing the buffer view data.
   * @param {object} options.bufferView The glTF buffer view object.
   * @param {Object<string, number>} options.compressedAttributes The compressed attributes.
   * @param {boolean} options.dequantizeInShader Whether POSITION and NORMAL attributes should be dequantized on the GPU.
   *
   * @returns {Promise} A promise that resolves to the decoded indices and attributes.
   * @private
   *
   * @exception {RuntimeError} Draco decoder could not be initialized.
   */
  static decodeBufferView(options) {
    const decoderTaskProcessor = DracoLoader._getDecoderTaskProcessor();

    if (defined(DracoLoader._error)) {
      throw DracoLoader._error;
    }

    if (!DracoLoader._taskProcessorReady) {
      // The task processor is not ready to schedule tasks
      return;
    }

    return decoderTaskProcessor.scheduleTask(options, [options.array.buffer]);
  }
}

// Maximum concurrency to use when decoding draco models
DracoLoader._maxDecodingConcurrency = Math.max(
  FeatureDetection.hardwareConcurrency - 1,
  1,
);

// Exposed for testing purposes
DracoLoader._decoderTaskProcessor = undefined;
DracoLoader._taskProcessorReadyPromise = undefined;
DracoLoader._taskProcessorReady = false;
DracoLoader._error = undefined;

export default DracoLoader;
