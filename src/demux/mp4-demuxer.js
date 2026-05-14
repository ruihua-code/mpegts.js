/*
 * Copyright (C) 2026. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import { createFile, DataStream } from 'mp4box';
import Log from '../utils/logger.js';
import MediaInfo from '../core/media-info.js';
import DemuxErrors from './demux-errors.js';
import SPSParser from './sps-parser.js';
import H265Parser from './h265-parser.js';
import { parseSEI } from './sei';

class MP4Demuxer {

    constructor(probeData, config) {
        this.TAG = 'MP4Demuxer';
        this._config = config;
        this._mp4box = createFile();
        this._mediaInfo = new MediaInfo();
        this._videoTrack = {type: 'video', id: 1, sequenceNumber: 0, samples: [], length: 0};
        this._videoMetadata = null;
        this._videoTrackInfo = null;
        this._videoCodecType = null;
        this._naluLengthSize = 4;
        this._timestampBase = 0;
        this._duration = 0;
        this._pendingSEI = [];
        this._ready = false;
        this._needsPostReadyFlush = false;

        this._onError = null;
        this._onMediaInfo = null;
        this._onTrackMetadata = null;
        this._onDataAvailable = null;
        this._onSEI = null;

        this._mp4box.onError = this._onMP4BoxError.bind(this);
        this._mp4box.onReady = this._onReady.bind(this);
        this._mp4box.onSamples = this._onSamples.bind(this);
    }

    static probe(buffer) {
        if (!buffer || buffer.byteLength < 8) {
            return {match: false, needMoreData: true};
        }

        let data = new Uint8Array(buffer);
        let boxType = String.fromCharCode(data[4], data[5], data[6], data[7]);
        let size = (data[0] << 24) | (data[1] << 16) | (data[2] << 8) | data[3];

        if (boxType === 'ftyp' && size >= 8) {
            return {match: true, consumed: 0};
        }

        return {match: false, needMoreData: false};
    }

    destroy() {
        if (this._mp4box) {
            this._mp4box.stop();
            this._mp4box = null;
        }
        this._mediaInfo = null;
        this._videoTrack = null;
        this._videoMetadata = null;
        this._videoTrackInfo = null;
        this._pendingSEI = null;
        this._ready = false;
        this._needsPostReadyFlush = false;
    }

    bindDataSource(loader) {
        loader.onDataArrival = this.parseChunks.bind(this);
        return this;
    }

    get onError() {
        return this._onError;
    }

    set onError(callback) {
        this._onError = callback;
    }

    get onMediaInfo() {
        return this._onMediaInfo;
    }

    set onMediaInfo(callback) {
        this._onMediaInfo = callback;
    }

    get onTrackMetadata() {
        return this._onTrackMetadata;
    }

    set onTrackMetadata(callback) {
        this._onTrackMetadata = callback;
    }

    get onDataAvailable() {
        return this._onDataAvailable;
    }

    set onDataAvailable(callback) {
        this._onDataAvailable = callback;
    }

    get onSEI() {
        return this._onSEI;
    }

    set onSEI(callback) {
        this._onSEI = callback;
    }

    set timestampBase(base) {
        this._timestampBase = base;
    }

    resetMediaInfo() {
        this._mediaInfo = new MediaInfo();
    }

    parseChunks(chunk, byteStart) {
        if (!this._onError || !this._onMediaInfo || !this._onTrackMetadata || !this._onDataAvailable) {
            throw new Error('MP4: onError & onMediaInfo & onTrackMetadata & onDataAvailable callback must be specified');
        }

        let buffer = chunk;
        if (!(buffer instanceof ArrayBuffer)) {
            buffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
        }

        buffer.fileStart = byteStart;
        this._mp4box.appendBuffer(buffer);

        return buffer.byteLength;
    }

    flush() {
        if (this._mp4box) {
            if (!this._ready) {
                this._needsPostReadyFlush = true;
            }
            this._mp4box.flush();
        }
    }

    _onMP4BoxError(error) {
        if (this._onError) {
            this._onError(DemuxErrors.FORMAT_ERROR, `MP4Box error: ${error}`);
        }
    }

    _onReady(info) {
        this._ready = true;
        this._duration = Math.floor(info.duration / info.timescale * 1000);
        let videoTrack = info.tracks.find((track) => {
            return track.video && /^(avc1|avc3|hvc1|hev1)\./.test(track.codec);
        });

        if (!videoTrack) {
            this._onError(DemuxErrors.CODEC_UNSUPPORTED, 'MP4: Unsupported or missing H.264/H.265 video track');
            return;
        }

        this._videoTrackInfo = videoTrack;
        this._videoCodecType = videoTrack.codec.startsWith('hvc1') || videoTrack.codec.startsWith('hev1') ? 'h265' : 'h264';
        this._videoTrack.id = videoTrack.id;

        this._mp4box.setExtractionOptions(videoTrack.id, null, {
            nbSamples: 100,
            rapAlignement: false
        });
        this._mp4box.start();

        if (this._needsPostReadyFlush) {
            this._needsPostReadyFlush = false;
            this._mp4box.flush();
        }
    }

    _onSamples(id, user, samples) {
        if (!samples || samples.length === 0) {
            return;
        }

        if (!this._videoMetadata) {
            this._parseVideoMetadata(samples[0]);
        }

        for (let i = 0; i < samples.length; i++) {
            this._parseVideoSample(samples[i]);
        }

        if (this._videoTrack.length) {
            this._onDataAvailable(null, this._videoTrack);
            this._videoTrack = {
                type: 'video',
                id: this._videoTrackInfo.id,
                sequenceNumber: this._videoTrack.sequenceNumber + 1,
                samples: [],
                length: 0
            };
            this._emitPendingSEI();
        }

        if (this._mp4box.releaseUsedSamples) {
            this._mp4box.releaseUsedSamples(id, samples[samples.length - 1].number);
        }
    }

    _parseVideoMetadata(sample) {
        let track = this._videoTrackInfo;
        let description = sample.description;
        let configBox = this._videoCodecType === 'h265' ? description.hvcC : description.avcC;
        let configRecord = this._serializeConfigRecord(configBox);

        if (!configRecord) {
            this._onError(DemuxErrors.FORMAT_ERROR, 'MP4: Missing video decoder configuration record');
            return;
        }

        let meta = this._videoMetadata = {};
        meta.type = 'video';
        meta.id = track.id;
        meta.timescale = 1000;
        meta.duration = this._duration;
        meta.codec = track.codec;

        if (this._videoCodecType === 'h265') {
            this._naluLengthSize = ((configRecord[21] & 3) + 1) || 4;
            meta.hvcc = configRecord;
            this._fillHEVCMetadata(meta, configRecord);
        } else {
            this._naluLengthSize = ((configRecord[4] & 3) + 1) || 4;
            meta.avcc = configRecord;
            this._fillAVCMetadata(meta, configRecord);
        }

        this._mediaInfo.hasAudio = false;
        this._mediaInfo.hasVideo = true;
        this._mediaInfo.duration = this._duration;
        this._mediaInfo.mimeType = `video/mp4; codecs="${meta.codec}"`;
        this._mediaInfo.videoCodec = meta.codec;
        this._mediaInfo.width = meta.codecWidth;
        this._mediaInfo.height = meta.codecHeight;
        this._mediaInfo.hasKeyframesIndex = false;

        this._onMediaInfo(this._mediaInfo);
        this._onTrackMetadata('video', meta);
    }

    _fillAVCMetadata(meta, avcc) {
        let offset = 6;
        let spsCount = avcc[5] & 31;
        if (spsCount === 0) {
            this._fillFallbackVideoMetadata(meta);
            return;
        }

        let spsLength = (avcc[offset] << 8) | avcc[offset + 1];
        offset += 2;
        let sps = avcc.subarray(offset, offset + spsLength);
        let config = SPSParser.parseSPS(sps);

        this._fillParsedVideoMetadata(meta, config);
        meta.profile = config.profile_string;
        meta.level = config.level_string;
        meta.bitDepth = config.bit_depth;
        meta.chromaFormat = config.chroma_format;
        meta.sarRatio = config.sar_ratio;
        this._mediaInfo.profile = meta.profile;
        this._mediaInfo.level = meta.level;
        this._mediaInfo.refFrames = config.ref_frames;
        this._mediaInfo.chromaFormat = config.chroma_format_string;
        this._mediaInfo.sarNum = meta.sarRatio.width;
        this._mediaInfo.sarDen = meta.sarRatio.height;
    }

    _fillHEVCMetadata(meta, hvcc) {
        let numOfArrays = hvcc[22];
        let offset = 23;
        for (let i = 0; i < numOfArrays; i++) {
            let nalUnitType = hvcc[offset] & 0x3F;
            let numNalus = (hvcc[offset + 1] << 8) | hvcc[offset + 2];
            offset += 3;

            for (let j = 0; j < numNalus; j++) {
                let len = (hvcc[offset] << 8) | hvcc[offset + 1];
                offset += 2;
                if (nalUnitType === 33) {
                    let sps = hvcc.subarray(offset, offset + len);
                    let config = H265Parser.parseSPS(sps);
                    this._fillParsedVideoMetadata(meta, config);
                    meta.profile = config.profile_string;
                    meta.level = config.level_string;
                    meta.bitDepth = config.bit_depth;
                    meta.chromaFormat = config.chroma_format;
                    meta.sarRatio = config.sar_ratio;
                    this._mediaInfo.profile = meta.profile;
                    this._mediaInfo.level = meta.level;
                    this._mediaInfo.refFrames = config.ref_frames;
                    this._mediaInfo.chromaFormat = config.chroma_format_string;
                    this._mediaInfo.sarNum = meta.sarRatio.width;
                    this._mediaInfo.sarDen = meta.sarRatio.height;
                    return;
                }
                offset += len;
            }
        }
        this._fillFallbackVideoMetadata(meta);
    }

    _fillParsedVideoMetadata(meta, config) {
        meta.codecWidth = config.codec_size.width;
        meta.codecHeight = config.codec_size.height;
        meta.presentWidth = config.present_size.width;
        meta.presentHeight = config.present_size.height;
        meta.frameRate = config.frame_rate;

        if (!meta.frameRate || meta.frameRate.fixed === false || meta.frameRate.fps_num === 0 || meta.frameRate.fps_den === 0) {
            this._fillFallbackVideoMetadata(meta);
            return;
        }

        meta.refSampleDuration = meta.timescale * (meta.frameRate.fps_den / meta.frameRate.fps_num);
        this._mediaInfo.fps = meta.frameRate.fps;
    }

    _fillFallbackVideoMetadata(meta) {
        let track = this._videoTrackInfo;
        meta.codecWidth = Math.floor(track.video.width || track.track_width || 0);
        meta.codecHeight = Math.floor(track.video.height || track.track_height || 0);
        meta.presentWidth = meta.codecWidth;
        meta.presentHeight = meta.codecHeight;
        meta.profile = '';
        meta.level = '';
        meta.bitDepth = 8;
        meta.chromaFormat = 1;
        meta.sarRatio = {width: 1, height: 1};
        meta.frameRate = {fixed: true, fps: 25, fps_num: 25, fps_den: 1};
        meta.refSampleDuration = 40;
        this._mediaInfo.fps = meta.frameRate.fps;
        this._mediaInfo.profile = meta.profile;
        this._mediaInfo.level = meta.level;
        this._mediaInfo.refFrames = 1;
        this._mediaInfo.chromaFormat = '4:2:0';
        this._mediaInfo.sarNum = 1;
        this._mediaInfo.sarDen = 1;
    }

    _parseVideoSample(sample) {
        let data = new Uint8Array(sample.data);
        let dts = this._timestampBase + sample.dts / sample.timescale * 1000;
        let pts = this._timestampBase + sample.cts / sample.timescale * 1000;
        let cts = pts - dts;
        let offset = 0;
        let units = [];
        let length = 0;
        let keyframe = sample.is_rap === true || sample.is_sync === true;

        while (offset + this._naluLengthSize <= data.byteLength) {
            let naluSize = this._readNaluSize(data, offset, this._naluLengthSize);
            if (naluSize <= 0 || offset + this._naluLengthSize + naluSize > data.byteLength) {
                Log.w(this.TAG, `Malformed Nalu near timestamp ${dts}, offset = ${offset}, dataSize = ${data.byteLength}`);
                break;
            }

            let naluOffset = offset + this._naluLengthSize;
            let unitType = this._videoCodecType === 'h265' ? (data[naluOffset] >> 1) & 0x3F : data[naluOffset] & 0x1F;
            let unit = data.subarray(offset, offset + this._naluLengthSize + naluSize);

            if (this._videoCodecType === 'h265') {
                if (unitType === 19 || unitType === 20 || unitType === 21) {
                    keyframe = true;
                }
                if (unitType === 39 || unitType === 40) {
                    this._parseSEIPayload(unit.subarray(this._naluLengthSize), pts, 'h265');
                }
            } else {
                if (unitType === 5) {
                    keyframe = true;
                }
                if (unitType === 6) {
                    this._parseSEIPayload(unit.subarray(this._naluLengthSize), pts, 'h264');
                }
            }

            units.push({type: unitType, data: unit});
            length += unit.byteLength;
            offset += this._naluLengthSize + naluSize;
        }

        if (units.length) {
            let videoSample = {
                units: units,
                length: length,
                isKeyframe: keyframe,
                dts: dts,
                cts: cts,
                pts: pts
            };
            this._videoTrack.samples.push(videoSample);
            this._videoTrack.length += length;
        }
    }

    _readNaluSize(data, offset, lengthSize) {
        let naluSize = 0;
        for (let i = 0; i < lengthSize; i++) {
            naluSize = (naluSize << 8) | data[offset + i];
        }
        return naluSize;
    }

    _parseSEIPayload(data, pts, codec) {
        let sei = parseSEI(data, pts, codec);
        if (sei) {
            this._pendingSEI.push(sei);
        }
    }

    _emitPendingSEI() {
        if (!this._onSEI) {
            this._pendingSEI.length = 0;
            return;
        }

        while (this._pendingSEI.length) {
            this._onSEI(this._pendingSEI.shift());
        }
    }

    _serializeConfigRecord(box) {
        if (!box || !box.write) {
            return null;
        }

        let stream = new DataStream();
        box.write(stream);
        let bytes = new Uint8Array(stream.buffer);
        return bytes.subarray(8);
    }

}

export default MP4Demuxer;
