'use strict';

/*
 * Created with @iobroker/create-adapter v2.5.0
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require('@iobroker/adapter-core');
// Load your modules here, e.g.:
const Registers = require(__dirname + '/lib/register.js');
const ModbusConnect = require(__dirname + '/lib/modbus_connect.js');
const ModbusServer = require(__dirname + '/lib/modbus_server.js');
const {driverClasses,dataRefreshRate} = require(__dirname + '/lib/types.js');
const {getAstroDate} = require(__dirname + '/lib/tools.js');

class Sun2000 extends utils.Adapter {

	/**
	 * @param {Partial<utils.AdapterOptions>} [options={}]
	 */
	constructor(options) {
		super({
			...options,
			name: 'sun2000',
			useFormatDate: true
		});

		this.lastTimeUpdated = new Date().getTime();
		this.lastStateUpdatedHigh = 0;
		this.lastStateUpdatedLow = 0;
		this.isConnected = false;
		this.devices = [];
		this.settings = {
			highIntervall : 20000,
			lowIntervall : 60000,
			address : '',
			port : 520,
			modbusTimeout : 10000,
			modbusConnectDelay : 5000,
			modbusDelay : 0,
			modbusAdjust : false,
			ms_address : '127.0.0.1',
			ms_port : 520,
			ms_active : false,
			ms_sentry : false
		};

		this.on('ready', this.onReady.bind(this));
		// this.on('stateChange', this.onStateChange.bind(this));
		// this.on('objectChange', this.onObjectChange.bind(this));
		// this.on('message', this.onMessage.bind(this));
		this.on('unload', this.onUnload.bind(this));
	}

	async initPath() {
		//inverter
		await this.extendObjectAsync('meter', {
			type: 'device',
			common: {
				name: 'device meter'
			},
			native: {}
		});
		await this.extendObjectAsync('collected', {
			type: 'channel',
			common: {
				name: 'channel collected'
			},
			native: {}
		});

		await this.extendObjectAsync('inverter', {
			type: 'device',
			common: {
				name: 'device inverter'
			},
			native: {}
		});

		for (const item of this.devices) {
			if (item.driverClass == driverClasses.inverter) {
				const path = 'inverter.'+item.index.toString();
				//const i = item.index;
				item.path = path;
				await this.extendObjectAsync(path, {
					type: 'channel',
					common: {
						name: 'channel inverter '+item.index.toString(),
						role: 'indicator'
					},
					native: {}
				});

				await this.extendObjectAsync(path+'.grid', {
					type: 'channel',
					common: {
						name: 'channel grid'
					},
					native: {}
				});

				await this.extendObjectAsync(path+'.info', {
					type: 'channel',
					common: {
						name: 'channel info',
						role: 'info'
					},
					native: {}
				});

				await this.extendObjectAsync(path+'.battery', {
					type: 'channel',
					common: {
						name: 'channel battery'
					},
					native: {}
				});

				await this.extendObjectAsync(path+'.string', {
					type: 'channel',
					common: {
						name: 'channel string'
					},
					native: {}
				});

				await this.extendObjectAsync(path+'.derived', {
					type: 'channel',
					common: {
						name: 'channel derived'
					},
					native: {}
				});
			}

			if (item.driverClass == driverClasses.sdongle) {
				item.path = '';
				await this.extendObjectAsync(item.path+'sdongle', {
					type: 'device',
					common: {
						name: 'device SDongle'
					},
					native: {}
				});
			}

		}

		/*
		//SmartCharger
		if (this.settings.deviceClass == driverClasses.charger) {
			this.log.debug('Ich bin ein '+driverClasses.charger);
			await this.extendObjectAsync('charger', {
				type: 'device',
				common: {
					name: 'device charger'
				},
				native: {}
			});
			for (const [i, item] of this.devices.entries()) {
				item.path = 'charger.'+String(i);
			}
		}
		*/
	}

	async StartProcess() {
		await this.initPath();
		this.modbusClient = new ModbusConnect(this,this.settings);
		this.modbusClient.setCallback(this.endOfmodbusAdjust.bind(this));
		this.state = new Registers(this);
		await this.atMidnight();
		this.dataPolling();
		this.runWatchDog();
		//v0.4.x
		if (this.settings.ms_active) {
			this.modbusServer = new ModbusServer(this,this.settings.ms_address,this.settings.ms_port);
			this.modbusServer.connect();
		}
	}

	async atMidnight() {
		this.settings.sunrise = getAstroDate(this,'sunrise');
		this.settings.sunset = getAstroDate(this,'sunset');

		const now = new Date();
		const night = new Date(
			now.getFullYear(),
			now.getMonth(),
			now.getDate() + 1, // the next day, ...
			0, 0, 0 // ...at 00:00:00 hours
		);
		const msToMidnight = night.getTime() - now.getTime();

		if (this.mitnightTimer) this.clearTimeout(this.mitnightTimer);
		this.mitnightTimer = this.setTimeout(async () => {
			await this.state.mitnightProcess();   //      the function being called at midnight.
			this.atMidnight();    	              //      reset again next midnight.
		}, msToMidnight);
	}

	async checkAndPrepare() {
		// Time of Using charging and discharging periodes (siehe Table 5-6)
		// tCDP[3]= 127
		const tCDP = [1,0,1440,383,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0]; //nicht aus dem Netz laden
		this.modbusClient.setID(this.devices[0].modbusId);  //Master Inverter
		const data = await this.modbusClient.readHoldingRegisters(47086,4); //
		/*
         127 - Working mode settings
          2 : Maximise self consumptions (default)
          5 : Time Of Use(Luna) - hilfreich bei dynamischem Stromtarif (z.B Tibber)
        */
		const workingMode = data[0];         // Working mode settings  2:Maximise self consumptio5=)
		const chargeFromGrid = data[1];      // Voraussetzung für Netzbezug in den Speicher (Luna)
		const gridChargeCutOff = data[2]/10; // Ab welcher Schwelle wird der Netzbezug beendet (default 50 %)
		const storageModel = data[3];        // Modell/Herrsteller des Speichers, 2 : HUAWEI-LUNA2000

		if (storageModel == 2) { //wurde nur mit Luna getestet!
			if (workingMode != 5 || chargeFromGrid != 1 ) {
				this.log.debug('Row '+data+'  Workingmode '+workingMode+ ' Charge from Grid '+chargeFromGrid+ ' Grid Cut Off '+gridChargeCutOff+'%');
				await this.modbusClient.writeRegisters(47086,[5,1,500]);
				//await writeRegistersAsync(1,47086,[5,1,500]); //[TOU,chargeFromGrid,50%]
				await this.modbusClient.writeRegisters(47255,tCDP);
				//await writeRegistersAsync(1,47255,tCDP);      //Plan:1,StartZeit:00:00,EndZeit: 24:00,Endladen/täglich
				/* ggf. sinnvoll
               await writeRegistersAsync(1,47075,[0,5000]); //max. charging power
               await writeRegistersAsync(1,47077,[0,5000]); //max. discharging power
               */
			}
		}
	}


	sendToSentry (msg)  {
		if (this.supportsFeature && this.supportsFeature('PLUGINS')) {
			const sentryInstance = this.getPluginInstance('sentry');
			if (sentryInstance) {
				const Sentry = sentryInstance.getSentryObject();
				if (Sentry) this.log.info('send to Sentry value: '+msg);
				Sentry && Sentry.withScope(scope => {
					scope.setLevel('info');
					scope.setExtra('key', 'value');
					Sentry.captureMessage(msg, 'info'); // Level "info"
				});
			}
		}
	}



	async endOfmodbusAdjust (info) {
		if (!info.modbusAdjust) {
			this.settings.modbusAdjust = info.modbusAdjust;
			this.settings.modbusDelay = Math.round(info.delay);
			//siehe jsonConfig.json
			if (this.settings.modbusDelay > 6000) this.settings.modbusDelay = 6000;
			this.settings.modbusTimeout = Math.round(info.timeout);
			if (this.settings.modbusTimeout > 30000) this.settings.modbusTimeout = 30000;
			if (this.settings.modbusTimeout < 5000) this.settings.modbusTimeout = 5000;
			this.settings.modbusConnectDelay = Math.round(info.connectDelay);
			if (this.settings.modbusConnectDelay > 10000) this.settings.modbusConnectDelay = 10000;
			if (this.settings.modbusConnectDelay < 2000) this.settings.modbusConnectDelay = 2000;
			//orignal Interval
			this.settings.highIntervall = this.config.updateInterval*1000;
			await this.adjustInverval();
			this.config.autoAdjust = this.settings.modbusAdjust;
			this.config.connectDelay = this.settings.modbusConnectDelay;
			this.config.delay = this.settings.modbusDelay;
			this.config.timeout = this.settings.modbusTimeout;
			this.updateConfig(this.config);
			this.log.info(JSON.stringify(info));
			this.log.info('New modbus settings are stored.');
			//this.sendToSentry(JSON.stringify(info));
		}
	}

	async adjustInverval () {
		if (this.settings.modbusAdjust) {
			this.settings.highIntervall = 10000*this.settings.modbusIds.length;
		} else {
			const minInterval = this.settings.modbusIds.length*(5000+5*this.settings.modbusDelay);
			if (minInterval> this.settings.highIntervall) {
				this.settings.highIntervall = minInterval;
			}
		}
		this.settings.lowIntervall = 60000;
		if (this.settings.highIntervall > this.settings.lowIntervall) {
			this.settings.lowIntervall = this.settings.highIntervall;
		}
		if (!this.settings.modbusAdjust) {
			if (this.config.updateInterval < Math.round(this.settings.highIntervall/1000)) {
				this.log.warn('The interval is too small. The value has been changed on '+this.config.updateInterval+' sec.');
				this.log.warn('Please check your configuration!');
			}
		}
		await this.setStateAsync('info.modbusUpdateInterval', {val: Math.round(this.settings.highIntervall/1000), ack: true});
	}

	/**
	 * Is called when databases are connected and adapter received configuration.
	 */
	async onReady() {
		// Initialize your adapter here
		// tiemout now in ms
		if (this.config.timeout <= 10) {
			this.config.timeout = this.config.timeout*1000;
			this.updateConfig(this.config);
		}
		//await this.setStateAsync('info.deviceClass', {val: this.config.deviceClass, ack: true});
		await this.setStateAsync('info.ip', {val: this.config.address, ack: true});
		await this.setStateAsync('info.port', {val: this.config.port, ack: true});
		await this.setStateAsync('info.modbusIds', {val: this.config.modbusIds, ack: true});
		await this.setStateAsync('info.modbusTimeout', {val: this.config.timeout, ack: true});
		await this.setStateAsync('info.modbusConnectDelay', {val: this.config.connectDelay, ack: true});
		await this.setStateAsync('info.modbusDelay', {val: this.config.delay, ack: true});
		// Load user settings
		if (this.config.address != '' && this.config.port > 0 && this.config.modbusIds != '' && this.config.updateInterval > 0 ) {
			this.settings.address = this.config.address;
			this.settings.port = this.config.port;
			this.settings.modbusTimeout = this.config.timeout; //ms
			this.settings.modbusDelay = this.config.delay; //ms
			this.settings.modbusConnectDelay = this.config.connectDelay; //ms
			this.settings.modbusAdjust = this.config.autoAdjust;
			this.settings.modbusIds = this.config.modbusIds.split(',').map((n) => {return Number(n);});
			this.settings.sDongleId = Number(this.config.sDongleId) ?? -1;
			if (this.settings.sDongleId < -1 && this.settings.sDongleId >= 255) this.settings.sDongleId = -1;
			this.settings.highIntervall = this.config.updateInterval*1000; //ms
			this.settings.ms_address = this.config.ms_address;
			this.settings.ms_port = this.config.ms_port;
			this.settings.ms_active = this.config.ms_active;
			this.settings.ms_sentry = this.config.ms_sentry;

			if (this.settings.modbusAdjust) {
				await this.setStateAsync('info.JSONhealth', {val: '{ message: "Adjust modbus settings"}', ack: true});
			} else {
				await this.setStateAsync('info.JSONhealth', {val: '{message : "Information is collected"}', ack: true});
			}

			if (this.settings.modbusIds.length > 0 && this.settings.modbusIds.length < 6) {
				this.adjustInverval();
				//ES6 use a for (const [index, item] of array.entries()) of loop
				for (const [i,id] of this.settings.modbusIds.entries()) {
					this.devices.push({
						index: i,
						modbusId: id,
						driverClass: driverClasses.inverter,
						meter: (i==0),
						numberBatteryUnits : 0
					});
				}
				if (this.settings.sDongleId >= 0) {
					this.devices.push({
						index: this.settings.modbusIds.length,
						modbusId: this.settings.sDongleId,
						driverClass: driverClasses.sdongle
					});
				}
				await this.StartProcess();
			} else {
				this.log.error('*** Adapter deactivated, can\'t parse modbusIds! ***');
				this.setForeignState('system.adapter.' + this.namespace + '.alive', false);
			}
		} else {
			this.log.error('*** Adapter deactivated, Adapter Settings incomplete! ***');
			this.setForeignState('system.adapter.' + this.namespace + '.alive', false);
		}
	}

	async dataPolling() {
		function timeLeft(target,factor =1) {
			const left = Math.round((target - new Date().getTime())*factor);
			if (left < 0) return 0;
			return left;
		}

		const start = new Date().getTime();
		this.log.debug('### DataPolling START '+ Math.round((start-this.lastTimeUpdated)/1000)+' sec ###');
		if (this.lastTimeUpdated > 0 && (start-this.lastTimeUpdated)/1000 > this.settings.highIntervall/1000 + 1) {
			this.log.info('Interval '+(start-this.lastTimeUpdated)/1000+' sec');
		}
		this.lastTimeUpdated = start;
		const nextLoop = this.settings.highIntervall - start % (this.settings.highIntervall) + start;

		//High Loop
		for (const item of this.devices) {
			this.lastStateUpdatedHigh += await this.state.updateStates(item,this.modbusClient,dataRefreshRate.high,timeLeft(nextLoop));
		}
		await this.state.runPostProcessHooks(dataRefreshRate.high);

		if (timeLeft(nextLoop) > 0) {
			//Low Loop
			for (const [i,item] of this.devices.entries()) {
				//this.log.debug('+++++ Loop: '+i+' Left Time: '+timeLeft(nextLoop,(i+1)/this.devices.length)+' Faktor '+((i+1)/this.devices.length));
				this.lastStateUpdatedLow += await this.state.updateStates(item,this.modbusClient,dataRefreshRate.low,timeLeft(nextLoop,(i+1)/this.devices.length));
			}
		}
		await this.state.runPostProcessHooks(dataRefreshRate.low);

		if (this.pollingTimer) this.clearTimeout(this.pollingTimer);
		this.pollingTimer = this.setTimeout(() => {
			this.dataPolling(); //recursiv
		}, timeLeft(nextLoop));
		this.log.debug('### DataPolling STOP ###');
	}

	runWatchDog() {
		this.watchDogHandle && this.clearInterval(this.watchDogHandle);
		this.watchDogHandle = this.setInterval( () => {
			const sinceLastUpdate = new Date().getTime() - this.lastTimeUpdated; //ms
			this.log.debug('Watchdog: time since last update '+sinceLastUpdate/1000+' sec');
			const lastIsConnected = this.isConnected;
			this.isConnected = this.lastStateUpdatedHigh > 0 && sinceLastUpdate < this.settings.highIntervall*3;
			if (this.isConnected !== lastIsConnected ) this.setState('info.connection', this.isConnected, true);
			//this.connected = this.isConnected;
			if (!this.settings.modbusAdjust) {
				if (!this.isConnected) {
					this.setStateAsync('info.JSONhealth', {val: '{errno:1, message: "Can\'t connect to inverter"}', ack: true});
				}
				if (this.alreadyRunWatchDog) {
					const ret = this.state.CheckReadError(this.settings.lowIntervall*2);
					const obj = {...ret,modbus: {...this.modbusClient.info}};
					this.log.debug(JSON.stringify(this.modbusClient.info));
					if (ret.errno) this.log.warn(ret.message);
					this.setStateAsync('info.JSONhealth', {val: JSON.stringify(obj), ack: true});
					//v0.4.x
					if (this.modbusServer) {
						!this.modbusServer.isConnected && this.modbusServer.connect();
						//this.settings.ms_sentry && this.sendToSentry(this.modbusServer.info);
						this.log.info(JSON.stringify(this.modbusServer.info));
					}
				}

			}

			if (!this.alreadyRunWatchDog) this.alreadyRunWatchDog = true;
			this.lastStateUpdatedLow = 0;
			this.lastStateUpdatedHigh = 0;

			if (sinceLastUpdate > this.settings.highIntervall*10) {
				this.setStateAsync('info.JSONhealth', {val: '{errno:2, message: "Internal loop error"}', ack: true});
				this.log.warn('watchdog: restart Adapter...');
				this.restart();
			}

		},this.settings.lowIntervall);
	}

	/**
	 * Is called when adapter shuts down - callback has to be called under any circumstances!
	 * @param {() => void} callback
	 */
	onUnload(callback) {
		try {
			this.setState('info.connection', false, true);
			this.modbusServer && this.modbusServer.close();
			this.pollingTimer && this.clearTimeout(this.pollingTimer);
			this.mitnightTimer && this.clearTimeout(this.mitnightTimer);
			this.watchDogHandle && this.clearInterval(this.watchDogHandle);
			this.modbusClient && this.modbusClient.close();
			this.log.info('cleaned everything up...');
			callback();
		} catch (e) {
			callback();
		}
	}

	// If you need to react to object changes, uncomment the following block and the corresponding line in the constructor.
	// You also need to subscribe to the objects with `this.subscribeObjects`, similar to `this.subscribeStates`.
	// /**
	//  * Is called if a subscribed object changes
	//  * @param {string} id
	//  * @param {ioBroker.Object | null | undefined} obj
	//  */
	// onObjectChange(id, obj) {
	// 	if (obj) {
	// 		// The object was changed
	// 		this.log.info(`object ${id} changed: ${JSON.stringify(obj)}`);
	// 	} else {
	// 		// The object was deleted
	// 		this.log.info(`object ${id} deleted`);
	// 	}
	// }

	// /**
	// * Is called if a subscribed state changes
	// * @param {string} id
	// * @param {ioBroker.State | null | undefined} state
	// **/

	/*
	onStateChange(id, state) {
		if (state) {
			// The state was changed
			this.log.info(`state ${id} changed: ${state.val} (ack = ${state.ack})`);
		} else {
			// The state was deleted
			this.log.info(`state ${id} deleted`);
		}
	}

	*/

	// If you need to accept messages in your adapter, uncomment the following block and the corresponding line in the constructor.
	// /**
	//  * Some message was sent to this instance over message box. Used by email, pushover, text2speech, ...
	//  * Using this method requires "common.messagebox" property to be set to true in io-package.json
	//  * @param {ioBroker.Message} obj
	//  */
	// onMessage(obj) {
	// 	if (typeof obj === 'object' && obj.message) {
	// 		if (obj.command === 'send') {
	// 			// e.g. send email or pushover or whatever
	// 			this.log.info('send command');

	// 			// Send response in callback if required
	// 			if (obj.callback) this.sendTo(obj.from, obj.command, 'Message received', obj.callback);
	// 		}
	// 	}
	// }

}

if (require.main !== module) {
	// Export the constructor in compact mode
	/**
	 * @param {Partial<utils.AdapterOptions>} [options={}]
	 */
	module.exports = (options) => new Sun2000(options);
} else {
	// otherwise start the instance directly
	new Sun2000();
}