async function fetchEvaluationData() {
    try {
        const response = await fetch('/api/evaluation-data');
        const result = await response.json();

        // Calculate Scuba Diving Index
        const scubaDivingIndex = calculateScubaDivingIndex(result);
        document.getElementById('scuba-diving-index').innerText = `Scuba Diving Index: ${scubaDivingIndex.toFixed(2)}`;

        // Calculate AQI
        const airQualityIndex = calculateAirQualityIndex(result);
        document.getElementById('air-quality-index').innerText = `Air Quality Index: ${airQualityIndex.toFixed(2)}`;
    } catch (error) {
        console.error('Error fetching evaluation data:', error);
    }
}

function calculateScubaDivingIndex(data) {
    // Example calculation logic for Scuba Diving Index
    const { humidity, temperature } = data;
    return temperature > 15 && temperature < 30 && humidity > 40 && humidity < 70 ? 100 : 50;
}

function calculateAirQualityIndex(data) {
    // Example calculation logic for AQI
    const { pm2_5, pm10 } = data;
    return (pm2_5 + pm10) / 2; // Simplified calculation
}

// Fetch data on page load
fetchEvaluationData();
