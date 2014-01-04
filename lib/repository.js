var redis = require("../config").redis,
	util = require('util'),
    async = require("async"),
	Cache = require('./cache');

var RedisRepository = function(objectContructor) {
	var cache = new Cache();
	var modelName = objectContructor.name.toLowerCase();

    this.save = function(value, callback) {        
    	// generate id if needed
		generateNextId(value, function(err, model) {

			cache.set(model.id, model);

            var data = modelToArchive(model);
			var key = modelName + ':' + model.id;

			console.log('Saving ' + key);
			console.log(util.inspect(data, {colors:true}));

			redis.set(key, JSON.stringify(data), callback);
		})
    };

    this.get = function(id, callback) {
    	var value = cache.get(id);
	    if (!value) return callback(new Error(objectContructor.name + " " + id + " not found"));

        callback(null, value);
    };

    this.remove = function(id, callback) {
    	console.log('Removing ' + modelName + ':' + id);
        cache.remove(id);
    	redis.del(modelName + ':' + id, callback);        
    };

    this.all = function(callback) {
    	redis.keys(modelName + ':*', function(err, keys) {
    		if (keys.length === 0) return callback(err, []);

    		redis.mget(keys, function(err, replies){
                if (err) return callback(err, []);

                loadModels(replies, callback);
    		});
    	});
    };

    this.filter = function(iterator, callback) {
        cache.filter(iterator, callback);
    }

    this.each = function(callback) {
    	cache.each(callback);
    };

    function modelToArchive(model) {
        var data = {};

        // prepare for serialization
        model.getSchema().forEach(function(prop) {
            // getter property
            if (typeof model[prop] === 'function') {
                data[prop] = model[prop].call(model);
            }
            else if (model[prop]) {
                data[prop] = model[prop];
            }
        });

        return data;
    }

    function loadModel(json, callback) {
        var props = JSON.parse(json); // !!! Can throw
        var model = cache.get(props.id);
        if (model) return callback(null, model);

        model = new objectContructor();
        initProperties.call(model, props);

        // keep it in cache
        cache.set(model.id, model);
        callback(null, model);
    };

    function loadModels(replies, callback) {
        var models = [];

        replies.forEach(function(json) {
            loadModel(json, function(err, model){
                if (err) console.log(err);
                models.push(model);
            });
        });

        callback(null, models);
    };

    function initProperties(sourceProps) {
		Object.keys(sourceProps).forEach(function(propName) {
	    	this[propName] = sourceProps[propName];
		}.bind(this));
    };

    function generateNextId(value, callback) {
    	// create new id
    	if (!value.id) {
    		redis.incr('id:' + modelName, function(err, id) {
    			value.id = id;
    			callback(err, value);
    		});
    	}
    	else {
    		callback(null, value);
    	}
    };
};



module.exports = RedisRepository;