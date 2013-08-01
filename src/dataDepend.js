/**
 * dataDepend - a toolkit for implementing complex, data heavy AngularJS applications
 *
 * See https://github.com/Nikku/angular-data-depend for details.
 *
 * @version 1.0.0
 *
 * @author Nico Rehwaldt <http://github.com/Nikku>
 * @author Roman Smirnov <https://github.com/romansmirnov>
 *
 * @license (c) 2013 Nico Rehwaldt, MIT
 */

(function(angular) {
  
  function createBinding(angular) {

    var module = angular.module('dataDepend', []);

    var isArray = angular.isArray, 
        isFunction = angular.isFunction,
        isObject = angular.isObject,
        forEach = angular.forEach,
        extend = angular.extend;

    function ensureArray(elements) {
      if (!isArray(elements)) {
        return [ elements ];
      } else {
        return elements;
      }
    }

    function toArray(arrayLike) {
      return Array.prototype.slice.apply(arrayLike);
    }

    var dataProviderFactory = [ '$rootScope', '$q', function($rootScope, $q) {
      
      function createFactory(nextTick) {

        function create(options) {
          
          options = options || {};

          var produces = options.produces,
              registry = options.registry,
              dependencies = options.dependencies || [],
              factory = options.factory, 
              eager = options.eager || false;

          var parentValues = {},
              children = [],
              changed = true,
              dirty = true,
              loading = null,
              data = { $loaded: false };

          // element produced by 
          // the factory
          var provider = {
            produces: produces,
            data: data,
            get: get, 
            set: set,
            resolve: resolve,
            children: children, 
            parentChanged: parentChanged
          };

          allDependenciesDo(function(d) {
            getProvider(d).children.push(provider);
          });

          if (eager) {
            log('resolve async');
            nextTick(function() {
              log('resolve');
              resolve();
            });
          }

          if (!factory) {
            setLoaded(options.value);
          }

          function setLoaded(newValue) {

            var oldValue = data.value;

            data.$loaded = true;
            changed = false;

            if (oldValue !== newValue) {
              data.value = newValue;
              
              log('setLoaded', oldValue, ' -> ', newValue);

              notifyParentChanged();
            }
          }

          function getTracker(name) {
            var tracker = parentValues[name];
            if (!tracker) {
              parentValues[name] = tracker = {};
            }

            return tracker;
          }

          function setLoading() {
            data.$loaded = false;
            dirty = false;
          }

          function getProvider(key) {
            var provider = registry[key];
            
            if (!provider) {
              throw new Error('[dataDepend] No provider for ' + key);
            }

            return provider;
          }

          function allChildrenDo(fn) {
            forEach(children, fn);
          }

          function allDependenciesDo(fn) {
            forEach(dependencies, fn);
          }

          function notifyParentChanged() {
            allChildrenDo(function(child) {
              child.parentChanged();
            });
          }

          function resolveDependencies() {
            var promises = [];

            function logValue(d, value) {
              var tracker = getTracker(d),
                  oldValue = tracker.value;

              log('resolveDependencies', d, ':', oldValue, '->', value);

              if (oldValue !== value) {
                log('resolveDependencies', 'changed');
                
                tracker.value = value;
                changed = true;
              }
            }

            allDependenciesDo(function(d) {
              var provider = getProvider(d);

              var promise = provider.resolve().then(function(value) {
                logValue(d, value);
                return value;
              });

              promises.push(promise);
            });

            return $q.all(promises).then(function() {

              var values = [];

              // best effort to receive up-to-date values
              // return the most current one
              allDependenciesDo(function(d) {
                var v = getProvider(d).get();

                logValue(d, v);

                values.push(v);
              });

              return values;
            });
          }

          function asyncLoad(reload) {
            setLoading();

            log('asyncLoad: init load');

            var promise = resolveDependencies().then(function(values) {

              log('asyncLoad dependencies resolved', values);

              if (loading !== promise) {
                log('asyncLoad: skip (new load request)');
                return loading;
              }

              var value = get();

              if (factory) {

                // call factory only if neccessary
                // (i.e. if parent variables changed, reload is explicitly set
                // or no dependencies are given)
                if (changed || reload || values.length == 0) {
                  log('asyncLoad: call factory');
                  value = factory.apply(factory, values);
                }
              }

              return value;
            }).then(function(value) {

              if (loading !== promise) {
                log('asyncLoad: skip (new load request)');
                return loading;
              }

              log('asyncLoad: load complete');

              loading = null;
              setLoaded(value);
              return value;
            });

            return promise;
          }

          /**
           * Receive a notification from the parent that it got changed
           * and update your state accordingly.
           *
           */
          function parentChanged() {

            log('parentChanged START');

            // anticipating parent change, everything ok
            if (loading) {
              log('parentChanged SKIP (loading)');
              return;
            }

            dirty = true;

            // should this provider resolve its data 
            // eagerly if it got dirty
            if (eager) {
              log('parentChanged RESOLVE async');

              nextTick(function() {
                log('parentChanged RESOLVE');
                resolve();
              });
            }

            notifyParentChanged();
          }

          function get() {
            return data.value;
          }

          /**
           * Resolve the value of this data holder
           */
          function resolve(options) {
            options = options || {};

            var reload = options.reload;

            if (dirty || reload) {
              loading = asyncLoad(reload);
            }

            if (loading) {
              log('resolve: load async');
              return loading;
            } else {
              log('resolve: load sync');
              return $q.when(get());
            }
          }

          function set(value) {
            if (factory) {
              throw new Error("[dataDepend] Cannot set value, was using factory");
            }

            setLoaded(value);
          }

          function log() {
            // var args = toArray(arguments);
            // args.unshift('[' + produces + ']');
            // args.unshift('[dataDepend]');

            // console.log.apply(console, args);
          }

          return provider;
        };

        // factory
        return {
          create: create
        };
      }

      return createFactory(function(fn) {
        $rootScope.$evalAsync(fn);
      });
    }];

    var dataDependFactory = [ '$rootScope', '$injector', 'dataProviderFactory', function($rootScope, $injector, dataProviderFactory) {

      function createFactory(annotate, nextTick) {

        function create() {

          var nextId = 0;
          var providers = {};

          function get(variables, callback) {

            var name = 'provider$' + nextId++;
            
            if (!callback) {
              // parse callback and variables from 
              // [ 'A', 'B', function(A, B) { ... }] notation 
              callback = variables;
              variables = annotate(callback);

              if (isArray(callback)) {
                callback = callback[callback.length - 1];
              }
            } else {
              // make sure we can use get('asdf', function(asdf) { })
              // in place of get([ 'asdf' ], function(asdf) { })
              variables = ensureArray(variables);
            }

            if (!isFunction(callback)) {
              throw new Error('[dataDepend] Must provide callback as second parameter or use [ "A", "B", function(a, b) { } ] notation');
            }

            var provider = internalCreateProvider({
              produces: name, 
              factory: callback, 
              dependencies: variables, 
              eager: true,
              registry: providers
            });

            // return handle to the
            // providers data
            return provider.data;
          }

          function internalCreateProvider(options) {
            var produces = options.produces,
                provider;

            if (!produces) {
              throw new Error("[dataDepend] Must provide produces when creating new provider");
            }

            provider = dataProviderFactory.create(options);

            if (isArray(produces)) {

              var __get = provider.get;
              var __resolve = provider.resolve;

              forEach(produces, function(name, idx) {

                function filter(values) {
                  if (!values) {
                    return values;
                  } else {
                    return values[idx];
                  }
                }

                providers[name] = angular.extend({}, provider, { 
                  resolve: function() {
                    var args = toArray(arguments);
                    return __resolve.apply(null, args).then(filter);
                  },
                  get: function() {
                    var args = toArray(arguments);
                    return filter(__get.apply(null, args));
                  }
                });
              });
            } else {
              providers[produces] = provider;
            }

            return provider;
          }

          function set(name, value) {
            var provider = providers[name],
                factory, 
                variables;

            if (provider) {
              provider.set(value);
              return;
            }

            if (isFunction(value) || isArray(value)) {
              // parse factory and variables from 
              // [ 'A', 'B', function(A, B) { ... }] notation 
              factory = value;
              variables = annotate(factory);
              value = undefined;

              if (isArray(factory)) {
                factory = factory[factory.length - 1];
              }
            }

            var provider = internalCreateProvider({
              produces: name, 
              factory: factory,
              value: value,
              dependencies: variables, 
              registry: providers
            });

            // return handle to the
            // providers data
            return provider.data;
          }

          function changed(name) {
            var provider = providers[name];

            if (!provider) {
              throw new Error('[dataDepend] Provider "' + name + '" does not exists');
            }

            provider.resolve({ reload: true });
          }

          return {
            $providers: providers, 

            get: get,
            set: set,
            changed: changed
          };
        }

        return {
          create: create
        };
      }

      return createFactory($injector.annotate, function(fn) {
        $rootScope.$evalAsync(fn);
      });
    }];

    module.factory('dataDependFactory', dataDependFactory);
    module.factory('dataProviderFactory', dataProviderFactory);

    return module;
  }

  if (typeof define === "function" && define.amd) {
    define([ "angular" ], function(angular) {
      return createBinding(angular);
    });
  } else
  if (typeof angular !== undefined) {
    createBinding(angular);
  } else {
    throw new Error("Cannot bind dataDepend: AngularJS not available on window or via AMD");
  }
})(angular);