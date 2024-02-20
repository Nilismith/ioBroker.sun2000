const ModbusRTU = require('modbus-serial');

// https://github.com/yaacov/node-modbus-serial/blob/master/examples/server.js
class ModbusServer {
	constructor (adapterInstance,ip, port) {
		this._ip = ip;
		this._port = port;
		this._isConnected = false;
		this.adapter = adapterInstance;

		this.vector = {
			getInputRegister: (addr, unitId, callback) => {
				callback({ modbusErrorCode: 0x01, msg: 'Illegal function (device does not support this read/write function)' });
			},
			getHoldingRegister: (addr, unitId, callback) => {
				this._handleGetReg(addr, 1, unitId, callback);
			},
			getMultipleInputRegisters: (startAddr, length,unitId, callback ) => {
				callback({ modbusErrorCode: 0x01, msg: 'Illegal function (device does not support this read/write function)' });
			},
			getMultipleHoldingRegisters: (startAddr, length, unitId, callback) => {
				this._handleGetReg(startAddr, length, unitId, callback);
			},
			getCoil: (addr,unitId, callback) => {
				callback({ modbusErrorCode: 0x01, msg: 'Illegal function (device does not support this read/write function)' });
			},
			setRegister: (addr, value,unitId, callback) => {
				callback({ modbusErrorCode: 0x01, msg: 'Illegal function (device does not support this read/write function)' });
			},
			setCoil: (addr, valueunitId, callback) => {
				callback({ modbusErrorCode: 0x01, msg: 'Illegal function (device does not support this read/write function)' });
			},
			readDeviceIdentification: () => { //function(addr)
				console.log('DeviceIntification');
				return {
					0x00: 'MyVendorName',
					0x01: 'MyProductCode',
					0x02: 'MyMajorMinorRevision',
					0x05: 'MyModelName',
					0x97: 'MyExtendedObject1',
					0xAB: 'MyExtendedObject2'
				};
			}
		};
	}

	get isConnected () {
		return this._isConnected;
	}

	async connect() {
		try {
			this.adapter.log.info('ModbusTCP listening on modbus://'+this._ip+':'+this._port);
			await this.close();
			this.serverTCP = new ModbusRTU.ServerTCP(this.vector, { host: this._ip, port: this._port, debug: true});
			this.serverTCP.on('initialized', () => {
				this.adapter.log.info('ModbusTCP server initialized');
				this._isConnected = true;
			});
			this.serverTCP.on('socketError', (err) => {
				this.adapter.log.error(err);
				this.serverTCP && this.serverTCP.close(this._closed.bind(this));
			});
		} catch (err){
			this.adapter.log.error('ModbusTCP server couldnt listen '+err?.message);
		}
	}

	async close() {
		this.serverTCP && await this.serverTCP.close(this._closed.bind(this));
	}

	_closed() {
		this._isConnected = false;
		this.adapter.log.info('ModbusTCP server closed');
	}

	getDeviceHandler(unitId) {
		for (const device of this.adapter.devices) {
			if (device.instance) {
				if (device.instance?.modbusId === unitId) return device.instance;
			}
		}

	}

	async _handleGetReg (startAddr, length, unitId, callback) {
		//this.adapter.log.debug('getMultipleHolgingRegisters '+unitId+' '+startAddr+' len '+length+' '+this._isConnected);
		try {
			const device = this.getDeviceHandler(unitId);
			if (device) {
			//this.adapter.log.debug('Device Info '+JSON.stringify(device?.info));
				const values = device.getHoldingRegisters(startAddr,length);
				if (!values[1]) {
					await this.wait(1000);
					callback({ modbusErrorCode: 0x05, msg: 'Acknowledge (requested data will be available later)' });
				} else {
					await this.wait(100);
					callback(undefined,values);
				}
			} else {
				await this.wait(2000);
				callback({ modbusErrorCode: 0x01, msg: 'Device ID '+unitId+' not supported by device' });
			}
		} catch (err) {
			await this.wait(2000);
			callback({ modbusErrorCode: 0x04, msg: 'Slave device failure (device reports internal error)' });
		}
	}

	wait(ms){
		return new Promise(resolve => setTimeout(resolve, ms));
	}
}

module.exports = ModbusServer;