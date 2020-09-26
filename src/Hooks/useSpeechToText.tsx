import { useState, useEffect, useRef } from 'react';

import Hark from 'hark';
import { startRecording, stopRecording } from './recorderHelpers';

import { isEdgeChromium } from 'react-device-detect';

const AudioContext = window.AudioContext || (window as any).webkitAudioContext;

const SpeechRecognition =
  window.SpeechRecognition || (window as any).webkitSpeechRecognition;

let recognition: SpeechRecognition;

// Chromium edge currently has a broken implementation
// of the web speech API and does not return any results
if (!isEdgeChromium && SpeechRecognition) {
  recognition = new SpeechRecognition();
}

export interface UseSpeechToTextTypes {
  continuous?: boolean;
  crossBrowser?: boolean;
  googleApiKey?: string;
  onStartSpeaking?: () => any;
  onStoppedSpeaking?: () => any;
  timeout?: number;
}

export default function useSpeechToText({
  continuous,
  crossBrowser,
  googleApiKey,
  onStartSpeaking,
  onStoppedSpeaking,
  timeout
}: UseSpeechToTextTypes) {
  const [isRecording, setIsRecording] = useState(false);

  const audioContextRef = useRef<AudioContext>();

  const [results, setResults] = useState<string[]>([]);
  const [error, setError] = useState('');

  const timeoutId = useRef<number>();
  const mediaStream = useRef<MediaStream>();

  useEffect(() => {
    if (!crossBrowser && !recognition) {
      setError('Speech Recognition API is only available on Chrome');
    }

    if (!navigator?.mediaDevices?.getUserMedia) {
      setError('getUserMedia is not supported on this device/browser :(');
    }

    if (!audioContextRef.current) {
      audioContextRef.current = new AudioContext();
    }
  }, []);

  // Chrome Speech Recognition API:
  // Only supported on Chrome browsers
  const chromeSpeechRecognition = () => {
    if (recognition) {
      // Continuous recording after stopped speaking event
      if (continuous) recognition.continuous = true;

      // start recognition
      recognition.start();

      // speech successfully translated into text
      recognition.onresult = (e) => {
        if (e.results) {
          setResults((prevResults) => [
            ...prevResults,
            e.results[e.results.length - 1][0].transcript
          ]);
        }
      };

      recognition.onaudiostart = () => setIsRecording(true);

      // Audio stopped recording or timed out.
      // Chrome speech auto times-out if no speech after a while
      recognition.onaudioend = () => {
        setIsRecording(false);
      };
    }
  };

  const startSpeechToText = async () => {
    if (recognition) {
      chromeSpeechRecognition();
      return;
    }

    if (!crossBrowser) {
      return;
    }

    const stream = await startRecording({
      errHandler: () => setError('Microphone permission was denied'),
      audioContext: audioContextRef.current as AudioContext
    });

    // Stop recording if timeout
    if (timeout) {
      handleRecordingTimeout();
    }

    // stop previous mediaStream track if exists
    if (mediaStream.current) {
      mediaStream.current.getAudioTracks()[0].stop();
    }

    // Clones stream to fix hark bug on Safari
    mediaStream.current = stream.clone();

    const speechEvents = Hark(mediaStream.current, {
      audioContext: audioContextRef.current as AudioContext
    });

    speechEvents.on('speaking', () => {
      if (onStartSpeaking) onStartSpeaking();

      // Clear previous recording timeout on every speech event
      clearTimeout(timeoutId.current);
    });

    speechEvents.on('stopped_speaking', () => {
      if (onStoppedSpeaking) onStoppedSpeaking();

      setIsRecording(false);
      mediaStream.current?.getAudioTracks()[0].stop();

      // Stops current recording and sends audio string to google cloud.
      // recording will start again after google cloud api
      // call if `continuous` prop is true. Until the api result
      // returns, technically the microphone is not being captured again
      stopRecording({
        exportWAV: true,
        wavCallback: (blob) =>
          handleBlobToBase64({ blob, continuous: continuous || false })
      });
    });

    setIsRecording(true);
  };

  const stopSpeechToText = () => {
    if (recognition) {
      recognition.stop();
    } else {
      setIsRecording(false);
      mediaStream.current?.getAudioTracks()[0].stop();
      stopRecording({
        exportWAV: true,
        wavCallback: (blob) => handleBlobToBase64({ blob, continuous: false })
      });
    }
  };

  const handleRecordingTimeout = () => {
    timeoutId.current = window.setTimeout(() => {
      setIsRecording(false);
      mediaStream.current?.getAudioTracks()[0].stop();
      stopRecording({ exportWAV: false });
    }, timeout);
  };

  const handleBlobToBase64 = ({
    blob,
    continuous
  }: {
    blob: Blob;
    continuous: boolean;
  }) => {
    const reader = new FileReader();
    reader.readAsDataURL(blob);

    reader.onloadend = async () => {
      const base64data = reader.result as string;

      let sampleRate = audioContextRef.current?.sampleRate;

      // Google only accepts max 48000 sample rate: if
      // greater recorder js will down-sample to 48000
      if (sampleRate && sampleRate > 48000) {
        sampleRate = 48000;
      }

      const audio = { content: '' };

      const config = {
        encoding: 'LINEAR16',
        languageCode: 'en-US',
        sampleRateHertz: sampleRate
      };

      const data = {
        config,
        audio
      };

      // Gets raw base 64 string data
      audio.content = base64data.substr(base64data.indexOf(',') + 1);

      const googleCloudRes = await fetch(
        `https://speech.googleapis.com/v1/speech:recognize?key=${googleApiKey}`,
        {
          method: 'POST',
          body: JSON.stringify(data)
        }
      );

      const googleCloudJson = await googleCloudRes.json();

      // Update results state with transcribed text
      if (googleCloudJson.results?.length > 0) {
        setResults((prevResults) => [
          ...prevResults,
          googleCloudJson.results[0].alternatives[0].transcript
        ]);
      }

      if (continuous) {
        startSpeechToText();
      }
    };
  };

  return { results, startSpeechToText, stopSpeechToText, isRecording, error };
}
