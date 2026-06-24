/*
 * G.711 A-law and μ-law decoder
 * Converts G.711 encoded audio to 16-bit PCM
 */

class G711 {
    // A-law decompression lookup table
    static _alawTable = null;
    
    // μ-law decompression lookup table
    static _mulawTable = null;

    static _initAlawTable() {
        if (this._alawTable) return;
        
        this._alawTable = new Int16Array(256);
        for (let i = 0; i < 256; i++) {
            let input = i ^ 0x55;  // XOR with 0x55
            let sign = (input & 0x80) ? -1 : 1;
            let exponent = (input & 0x70) >> 4;
            let mantissa = input & 0x0F;
            
            let value = mantissa * 2 + 33;
            value = value << (exponent + (exponent > 0 ? 3 : 4));
            
            this._alawTable[i] = sign * value;
        }
    }

    static _initMulawTable() {
        if (this._mulawTable) return;
        
        this._mulawTable = new Int16Array(256);
        for (let i = 0; i < 256; i++) {
            let input = ~i;  // Invert bits
            let sign = (input & 0x80) ? -1 : 1;
            let exponent = (input & 0x70) >> 4;
            let mantissa = input & 0x0F;
            
            let value = ((mantissa << 3) + 0x84) << exponent;
            value = value - 0x84;
            
            this._mulawTable[i] = sign * value;
        }
    }

    /**
     * Decode G.711 A-law to 16-bit PCM
     * @param {Uint8Array} input - A-law encoded data
     * @returns {Int16Array} - 16-bit PCM data
     */
    static decodeAlaw(input) {
        this._initAlawTable();
        
        let output = new Int16Array(input.length);
        for (let i = 0; i < input.length; i++) {
            output[i] = this._alawTable[input[i]];
        }
        return output;
    }

    /**
     * Decode G.711 μ-law to 16-bit PCM
     * @param {Uint8Array} input - μ-law encoded data
     * @returns {Int16Array} - 16-bit PCM data
     */
    static decodeMulaw(input) {
        this._initMulawTable();
        
        let output = new Int16Array(input.length);
        for (let i = 0; i < input.length; i++) {
            output[i] = this._mulawTable[input[i]];
        }
        return output;
    }
}

export default G711;
