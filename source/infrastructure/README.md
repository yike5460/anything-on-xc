# Tuturial on how to hosting Stable Diffusion WebUI on AWS EC2

## Key feature to consider

- Elastic scaling for 2C customer, the EC2 cluster will scale up to handle the request and vice versa when the request is high, the scaling time for a new EC2 instance come to available and ready to receive request should be under 2 minutes. The average launch time of EC2 instance is around 17-18 seconds according to benchmark ([benchmark script](../scripts/ec2-benchmark.sh))
- API support for application integration without awareness of the underlying framework and infrastructure, e.g. WebUI/CompyUI
- Optimized inference speed for 2C customer, the inference time should be around 2-3 seconds whether using asyn or syn mode
- Support for Spot instance to reduce the cost of running the cluster, careful consideration should be taken to ensure the cluster can handle the spot instance termination
- Model switching support, the cluster should be able to switch between different model without much waiting time, consider to load the model into memory then local cache to reduce the loading time and use S3 File Gateway or EFS to store the model
- Metric and logging support, the cluster should be able to provide the metric and logging for monitoring and debugging purpose, furthermore, the scaling activity is triggered by such metric, e.g. ([nvidia_smi_utilization_gpu](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch-Agent-NVIDIA-GPU.html))
- Consider the concurrency of the cluster (Kafka as the message queue to distribute the request to different EC2 instance), the cluster should be able to handle the request from multiple customer at the same time, the concurrency of the cluster should be around 100 TPS (Transaction per second) for 2C customer, sync and async mode should be supported since text to video inference is a time consuming task
- Pack boilerplate AMI including all the necessary software and library to reduce the launch time of EC2 instance, the AMI should be able to launch the cluster with minimum configuration
- All generated images and videos will be stored in S3 bucket and user will get the link to the image and video by using S3 and CloudFront (CDN) to reduce the latency of the request and S3API cost
- Consider to use custom chip, e.g. AWS Inferentia, to reduce the cost of running the cluster

## Architecture

## Note
The transfer time from s3fs mounted file to local folder is around 159 mb/s (6.5 * 1000 mb/41s) and the transfer time from local folder to s3fs mounted file is around 148 mb/s (6.5 * 1000 mb/44s)
