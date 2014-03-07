var util = require("util"),
	User = require("./user"),
	Driver = require("./driver").Driver,
	Cache = require('../lib/cache'),
	Repository = require('../lib/repository'),
	MessageFactory = require("../messageFactory"),
	geofence = require("../lib/geofence");

function Client() {
	User.call(this, Client.LOOKING);	
}

util.inherits(Client, User);

var repository = new Repository(Client);

/**
 * Client States
 */

['Looking', 'Dispatching', 'WaitingForPickup', 'OnTrip', 'PendingRating'].forEach(function (readableState, index) {
	var state = readableState.toUpperCase();
  Client.prototype[state] = Client[state] = readableState;
});

/////////////////////////////////////////////////////
// Requests

Client.prototype.login = function(context, callback) {
	console.log('Client ' + this.id + ' login');
	this.updateLocation(context);
	this.save();

	this._generateOKResponse(true, callback);
}

Client.prototype.logout = function(context) {
	console.log('Client ' + this.id + ' logout');
	this.updateLocation(context);
	this.token = null;
	this.save();

	return MessageFactory.createClientOK(this);
}

// Return client state and trip if any or available vehicles nearby
Client.prototype.ping = function(context, callback) {
	this.updateLocation(context);

	this._generateOKResponse(false, callback);
}

Client.prototype.pickup = function(context, trip) {
	this.updateLocation(context);

	if (this.state === Client.LOOKING) {
		this.setTrip(trip);
		// Change state causes event to be published which reads this.trip, so it has to be set prior to that
		this.changeState(Client.DISPATCHING);
		this.save();		
	}	

	return MessageFactory.createClientDispatching(this, this.trip);
}

// Client explicitly canceled pickup
Client.prototype.cancelPickup = function(context) {
	this.updateLocation(context);
	
	if (this.state === Client.DISPATCHING) {
		this.changeState(Client.LOOKING);
		this.save();
	}

	return MessageFactory.createClientOK(this);
}

// Client explicitly canceled trip
Client.prototype.cancelTrip = function(context) {
	this.updateLocation(context);	

	if (this.state === Client.WAITINGFORPICKUP) {
		this.changeState(Client.LOOKING);
		this.save();
	}
	
	return MessageFactory.createClientOK(this);
}

Client.prototype.rateDriver = function(context, callback) {
	this.updateLocation(context);

	if (this.state === Client.PENDINGRATING) {
		require('../backend').rateDriver(this.trip.id, context.message.rating, context.message.feedback, function() {
			this.changeState(Client.LOOKING);
			this.save();

			callback(null, MessageFactory.createClientOK(this));
		}.bind(this));
	}
	else 
		callback(null, MessageFactory.createClientOK(this));
}

/////////////////////////////////////////////////////
// Notifications

Client.prototype.notifyDriverConfirmed = function() {
	if (this.state !== Client.DISPATCHING) return;
		
	this.changeState(Client.WAITINGFORPICKUP);
	this.save();
	
	require('../backend').smsTripStatusToClient(this.trip, this);		
	
	this.send(MessageFactory.createClientOK(this, { trip: this.trip }));
}

// Driver pressed 'Begin Trip' to start trip
Client.prototype.notifyTripStarted = function() {
	if (this.state !== Client.WAITINGFORPICKUP) return;
	
	this.changeState(Client.ONTRIP);

	this.send(MessageFactory.createTripStarted(this, this.trip));

	this.save();
}

Client.prototype.notifyDriverEnroute = function() {
	if (this.trip)
		this.send(MessageFactory.createClientDriverEnroute(this.trip));
}

// Notify client that driver canceled trip
Client.prototype.notifyTripCanceled = function() {
	if (this.state !== Client.WAITINGFORPICKUP) return;

	require('../backend').smsTripStatusToClient(this.trip, this);

	// nulls out this.trip
	this.changeState(Client.LOOKING);	

	this.send(MessageFactory.createClientTripCanceled(this, "Водитель вынужден был отменить ваш заказ."));

	this.save();
}

Client.prototype.notifyDriverArriving = function() {
	if (this.state !== Client.WAITINGFORPICKUP) return;
	
	this.send(MessageFactory.createArrivingNow(this.trip));

	require('../backend').smsTripStatusToClient(this.trip, this);
}

Client.prototype.notifyTripFinished = function() {
	if (this.state !== Client.ONTRIP) return;

	this.changeState(Client.PENDINGRATING);
	this.save();

	this.send(MessageFactory.createClientEndTrip(this, this.trip))
}

// Notify client that pickup request was canceled
Client.prototype.notifyPickupCanceled = function(reason) {
	if (this.state !== Client.DISPATCHING) return;

 	console.log('Cancel client ' + this.id + ' pickup');

	this.changeState(Client.LOOKING);
	this.save();
	this.send(MessageFactory.createClientPickupCanceled(this, reason));
}

Client.prototype.notifyTripBilled = function() {
	this.send(this._createOK(false));
}

//////////////////////////////////////////
// Utility methods

Client.prototype._createOK = function(includeToken) {
	var options = {
		includeToken: includeToken,
		trip: this.trip,
		tripPendingRating: this.state === Client.PENDINGRATING
	}

	return MessageFactory.createClientOK(this, options);
}

Client.prototype._generateOKResponse = function(includeToken, callback) {
	if (this.trip) {
		callback(null, this._createOK(includeToken));
	}
	else if (this.state === Client.LOOKING) {
		this._updateNearbyDrivers({includeToken: includeToken}, callback);
	}
}

Client.prototype.getSchema = function() {
  var props = User.prototype.getSchema.call(this);
  props.push('paymentProfile');
  return props;
}

Client.prototype.save = function(callback) {
	repository.save(this, callback);
}

Client.prototype.changeState = function(state) {
  User.prototype.changeState.call(this, state);
  
  if (this.state === Client.LOOKING) {
    this.clearTrip();
  }
}

// TODO: Обновилась позиция всего одного водителя и не нужно пересчитывать расстояние и время прибытия
// всех остальных
//  Notify client about changes in nearby vehicles
Client.prototype.updateNearbyDrivers = function(callback) {
	if (!this.connected || this.state !== Client.LOOKING) return;
	
	console.log('Update nearby drivers for client ' + this.id + ', connected: ' + this.connected + ', state: ' + this.state);
	this._updateNearbyDrivers({}, function(err, response) {
		this.send(response, callback);
	}.bind(this));
}

Client.prototype._updateNearbyDrivers = function(options, callback) {
	if (!Client.canRequestToLocation(this.location)) {
		options.restrictedArea = true;
		return callback(null, MessageFactory.createClientOK(this, options));
	}

	Driver.findAllAvailableNearLocation(this.location, function(err, vehicles) {
		options.vehicles = vehicles;
		callback(err, MessageFactory.createClientOK(this, options));
	}.bind(this));
}

Client.prototype.toJSON = function() {
  var obj = User.prototype.toJSON.call(this);
  if (this.trip) {
    obj.pickupLocation = this.trip.pickupLocation;
  }
  return obj;
}

Client.publishAll = function() {
  repository.all(function(err, user) {
    user.forEach(function(user) {
      user.publish();
    });
  });
}

Client.canRequestToLocation = function(location) {
	return true;
	//return geofence.isLocationAllowed(location);
}

// export Client constructor
module.exports.Client = Client;
module.exports.repository = repository;