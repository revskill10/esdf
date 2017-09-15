/**
 * @module esdf/utils/tryWith
 */

var when = require('when');
var enrichError = require('./enrichError.js').enrichError;
var hashTransform = require('./hashTransform.js').hashTransform;
var RetryStrategy = require('./RetryStrategy.js');

//TODO: Document the options.retryStrategy parameter.

/**
 * Load an Aggregate Root instance and execute a function on it.
 * @param {function} loaderFunction The function that shall be used for loading the Aggregate Root. One can be obtained from esdf.utils.createAggregateLoader.
 * @param {function} ARConstructor A constructor which, when called with "new", should return an Aggregate Root instance in its base (zero) state. Used by the loader function.
 * @param {string} ARID ID of the Aggregate Root to load. The storage unit (for example, event stream) associated with this ID is loaded and used to restore the state of the AR.
 * @param {function} userFunction The function that will be executed against the Aggregate Root instance after it has been rehydrated. It accepts a single argument - the instance - and should return a promise-or-value. The aggregate's state is only saved once the promise resolves.
 * @param {Object} [options] Additional settings specifying how the load/execute/save operation should be carried out.
 * @param {function} [options.failureLogger] A function which shall be called if an error during loading or saving occurs. The error is passed as the sole argument to the failure logger function.
 * @param {Boolean} [options.advanced=false] Whether advanced return mode should be enabled. In advanced mode, the returned object is not the userFunction result itself, but instead an Object: { result, rehydration }, where rehydration is additional information about the loading process itself.
 * @param {Number} [options.diffSince=Infinity] A sequence slot to compute a difference from in advanced mode. All commits in slots greater than this value are returned, barring the commit that is generated in the current invocation (unless "newCommits" is used).
 * @param {Boolean} [options.newCommits=false] Whether the commit generated in course of executing the user function should be included in diffCommits. By default, only past commits that have existed at time of loading are returned.
 * @returns {Promise} A Promise which fulfills with the value which the userFunction has returned/fulfilled with, or rejects if the loading, execution of the user function or the saving failed. In advanced mode, it resolves with an Object that contains the value and other properties.
 */
function tryWith(loaderFunction, ARConstructor, ARID, userFunction, options){
	options = options || {};

	// Process the provided options.
	// Delay function, used to delegate execution to the event loop some time in the future.
	var delegationFunction = (options.delegationFunction) ? options.delegationFunction : setImmediate;
	function delay(continuation) {
		return when.promise(function(resolve){
			delegationFunction(resolve);
		}).then(continuation);
	}
	// Allow the caller to specify a failure logger function, to which all intermediate errors will be passed.
	var failureLogger = (options.failureLogger) ? options.failureLogger : function(){};

	// By default, an infinite retry strategy is employed.
	var retryStrategy = (typeof(options.retryStrategy) === 'function') ? options.retryStrategy : RetryStrategy.CounterStrategyFactory(Infinity);
	var shouldTryAgain = function shouldTryAgain(error){
		var strategyError = retryStrategy(error);
		// The strategy should tell us whether it thinks retrying is reasonable:
		var strategyRetryDecision = (!strategyError);
		// However, we do not have to agree with it - all critical errors, no matter what the strategy has decided, should fail the tryWith procedure.
		var ownDecision = (error && error.labels && error.labels.isRetriable);

		return strategyRetryDecision && ownDecision;
	};

	function singlePass() {
		// Delegate the loading itself to the dependency-injected loader function (hopefully, it's something useful, such as a bound Event Store method).
		return when.try(loaderFunction, ARConstructor, ARID, {
			// Always use the "advanced mode" output of the loader internally, so that we get more information, including a "commit diff".
			advanced: true,
			// Pass the diffSince option through.
			diffSince: options.diffSince
		}).then(function runUserFunction(loadingResult) {
			var aggregateInstance = loadingResult.instance;
			var stagedCommit;

			return when.try(userFunction, aggregateInstance).then(function saveAggregateState(userFunctionResult) {
				// Get the events staged by the aggregate root in course of execution and eventually append them to the result if requested.
				stagedCommit = aggregateInstance.getCommit(options.commitMetadata || {});

				// Actually commit:
				return when.try(aggregateInstance.commit.bind(aggregateInstance), options.commitMetadata || {}).then(function _buildOutput() {
					// If the caller has requested an "advanced format" result, pass the data through to them, enriched with the result of the user function.
					if (options.advanced) {
						var output = {
							result: userFunctionResult,
							rehydration: loadingResult.rehydration
						};
						// Additionally, if "newCommits" is enabled, also add the events produced by the current invocation to the returned property.
						if (options.newCommits) {
							output.rehydration.diffCommits = (output.rehydration.diffCommits || []).concat([ stagedCommit ]);
						}
						return output;
					}
					else {
						return userFunctionResult;
					}
				}, function handleSavingError(savingError) {
					failureLogger(savingError);
					var strategyAllowsAnotherTry = shouldTryAgain(savingError);
					if (strategyAllowsAnotherTry) {
						return delay(singlePass);
					}
					else {
						return when.reject(savingError);
					}
				});
			});
		}, function handleLoadingError(loadingError) {
			failureLogger(loadingError);
			var strategyAllowsAnotherTry = shouldTryAgain(loadingError);
			if (strategyAllowsAnotherTry) {
				return delay(singlePass);
			}
			else {
				return when.reject(loadingError);
			}
		});
	}

	return singlePass();
}

module.exports.tryWith = tryWith;
